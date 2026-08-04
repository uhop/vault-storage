// Search-before-write primitive. Embeds a proposed body (chunk-level,
// same pipeline as ingest), runs the two-phase scan from find-duplicates
// against existing records, returns top-K nearest sorted by min-
// pairwise-chunk-distance. Read-only — no write side effects.
//
// Use cases:
//   1. Agent calls `POST /vault/propose` before deciding whether to
//      write a new record. Surfaces near-duplicates in the existing
//      knowledge base so the agent can choose replace / supersede /
//      augment instead of creating a silent overlap.
//   2. `PUT /vault/{path}?check=true` invokes this internally and
//      returns 409 when any candidate falls below a tight threshold.
//
// The metric is identical to find-duplicates phase 2 (min cosine over
// chunk pairs). Unlike find-duplicates this is a 1-vs-N scan, not N², so
// it runs chunk-level directly over the bulk-loaded arrays — no doc-level
// prefilter.
//
// There *was* one until 2026-08-03, and it was wrong twice over. It
// compared L2² of the mean-pool centroid against `prefilterMaxDistance²`
// while the distance this returns (and that callers threshold against) is
// chunk cosine — so the documented 0.5 default was really a 0.125 cosine
// ceiling, below the band the endpoint exists to surface. And the bound it
// claimed ("centroid > threshold ⇒ no chunk pair can be close, by the
// triangle inequality") does not hold: mean-pooling smears, so a short
// proposal matching one section of a long note has a distant centroid and
// a near chunk. Worst exactly where search-before-write matters most.
// Removing it cost nothing measurable — the full 1,725-record chunk scan
// runs ~400 ms end-to-end, inside the BGE embedding cost that dominates,
// and both phases already bulk-load every vector, so the prefilter never
// saved a query either. find-duplicates keeps its own prefilter: N² there
// makes the trade genuinely different.
//
// `excludeRecordId` removes the target's own existing record when
// updating an existing path — without it, a tiny FM-only edit would
// always self-match at distance ≈ 0.

import type {DatabaseSync} from 'node:sqlite';
import {RecordVecRepository} from '../db/vec-repo.ts';
import {chunkBody} from '../embeddings/chunker.ts';
import type {Embedder} from '../embeddings/types.ts';
import {RecordsRepository} from '../records/repository.ts';

export interface ProposeCandidate {
  recordId: string;
  filePath: string;
  /** Min cosine distance over chunk pairs (`1 - dot(a_i, b_j)`). */
  distance: number;
  /** `agent.summary` from FM if present, else null. */
  agentSummary: string | null;
}

export interface ProposeOptions {
  /** Top-K to return after sorting. Default 10. */
  k?: number;
  /**
   * Ceiling on the returned distance — same metric and units as
   * {@link ProposeCandidate.distance} (min chunk cosine), so it filters
   * exactly the quantity it is compared against. Default: uncapped, with
   * `k` bounding the result instead.
   */
  maxDistance?: number;
  /**
   * Exclude this record from results — typically the existing record
   * at the target path on an update, so an FM-only edit doesn't
   * self-match at distance ≈ 0.
   */
  excludeRecordId?: string;
}

export interface ProposeResult {
  candidates: ProposeCandidate[];
  /** Number of chunks the proposed body produced (post-NaN-filter). */
  proposedChunks: number;
  /** Records compared at chunk level (every record holding chunks, less the excluded one). */
  candidatesScreened: number;
  /** The ceiling actually applied, echoed so an empty result is readable. */
  maxDistance: number;
  durationMs: number;
}

const isAllFinite = (v: Float32Array): boolean => {
  for (let i = 0; i < v.length; ++i) if (!Number.isFinite(v[i]!)) return false;
  return true;
};

const minPairwiseChunkDistance = (
  a: readonly Float32Array[],
  b: readonly Float32Array[]
): number => {
  if (a.length === 0 || b.length === 0) return Infinity;
  const dim = a[0]!.length;
  let bestDot = -Infinity;
  for (const av of a) {
    for (const bv of b) {
      let dot = 0;
      for (let i = 0; i < dim; ++i) dot += av[i]! * bv[i]!;
      if (dot > bestDot) bestDot = dot;
    }
  }
  return 1 - bestDot;
};

/**
 * Widest decoration shift worth re-scoring. Stored chunks carry the record's
 * `agent.summary` as a HyDE prefix (chunker.ts); a proposal arrives bare, so
 * every distance against a summarized record is inflated. Measured across
 * eight live topic notes scored against their own verbatim bodies, the shift
 * ran 0.048–0.113 — hence 0.15, comfortably past the observed worst case. A
 * candidate further than `threshold + this` cannot be pulled under the
 * threshold by stripping the prefix, so it never needs the extra embed.
 */
const DECORATION_SLACK = 0.15;

export interface DuplicateBlocker extends ProposeCandidate {
  /** Distance before the correction — the bare-vs-decorated figure the scan reported. */
  bareDistance: number;
  /** True when the stored side was re-embedded undecorated; false when it had no summary. */
  corrected: boolean;
}

/**
 * Records that duplicate `body` closely enough to block a write.
 *
 * Straight distance comparison is asymmetric and unreliable here: stored chunks
 * are decorated with their record's `agent.summary`, a freshly authored body has
 * none, and the resulting inflation varies by summary (0.048–0.113 measured),
 * straddling the 0.10 gate default — so a verbatim copy of one note is caught
 * while a verbatim copy of another slips through.
 *
 * Two tempting fixes both fail, for the same reason. Decorating the proposal
 * with its *own* summary loses to summary content: a different-but-plausible
 * summary scores the true twin *worse* than sending nothing (0.1022 vs 0.1130).
 * Decorating it with the *candidate's* summary looks right — a verbatim body
 * does score 0.0000 — but the shared prefix does not cancel, it **dominates**:
 * measured live, unrelated notes went from 0.17–0.20 bare to 0.007–0.037, which
 * would block nearly every write. A common prefix adds a common component to
 * both vectors; that raises cosine similarity for any pair.
 *
 * So the correction runs the other way — undecorate the *stored* side.
 * `chunkBody` splits on the body and applies the prefix afterwards, so
 * re-chunking a stored body with no summary reproduces its exact segments minus
 * the prefix, and bare-vs-bare is a true body comparison. That costs one embed
 * per candidate, so it runs only on the shortlist the bare scan already ranked
 * (rank-1 self-recall was 8/8, which is what makes a shortlist safe) and only
 * within {@link DECORATION_SLACK}.
 */
export const findDuplicateBlockers = async (
  db: DatabaseSync,
  embedder: Embedder,
  body: string,
  options: {threshold: number; excludeRecordId?: string; k?: number}
): Promise<DuplicateBlocker[]> => {
  const {threshold, excludeRecordId} = options;
  const bare = await proposeNearest(db, embedder, body, null, {
    k: options.k ?? 10,
    maxDistance: threshold + DECORATION_SLACK,
    ...(excludeRecordId !== undefined ? {excludeRecordId} : {})
  });
  if (bare.candidates.length === 0) return [];

  const proposedVecs = (await embedder.embedBatch(chunkBody(body, {summary: null}))).filter(
    isAllFinite
  );
  if (proposedVecs.length === 0) return [];

  const records = new RecordsRepository(db);
  const blockers: DuplicateBlocker[] = [];
  for (const c of bare.candidates) {
    // No summary on the record means its stored chunks are undecorated
    // already, so the bare distance is the symmetric one — nothing to strip.
    if (c.agentSummary === null) {
      if (c.distance <= threshold) {
        blockers.push({...c, bareDistance: c.distance, corrected: false});
      }
      continue;
    }
    const rec = records.getById(c.recordId);
    if (!rec) continue;
    const candVecs = (await embedder.embedBatch(chunkBody(rec.body, {summary: null}))).filter(
      isAllFinite
    );
    if (candVecs.length === 0) continue;
    const distance = minPairwiseChunkDistance(proposedVecs, candVecs);
    if (!Number.isFinite(distance) || distance > threshold) continue;
    blockers.push({...c, distance, bareDistance: c.distance, corrected: true});
  }
  blockers.sort((a, b) => a.distance - b.distance);
  return blockers;
};

/**
 * Embed the proposed body and return its top-K nearest existing records by
 * min chunk cosine. Returns candidates sorted by ascending distance —
 * caller decides what threshold means "too close to write" for their use
 * case.
 */
export const proposeNearest = async (
  db: DatabaseSync,
  embedder: Embedder,
  body: string,
  agentSummary: string | null,
  options: ProposeOptions = {}
): Promise<ProposeResult> => {
  const k = options.k ?? 10;
  const maxDistance = options.maxDistance ?? Infinity;
  const excludeRecordId = options.excludeRecordId;

  const start = performance.now();
  const empty = (proposedChunks: number): ProposeResult => ({
    candidates: [],
    proposedChunks,
    candidatesScreened: 0,
    maxDistance,
    durationMs: Math.round(performance.now() - start)
  });

  // No length guard on chunkTexts: chunkBody always returns at least one
  // chunk (`''` yields `['']`), and an empty batch would fall through to the
  // cleanVecs check below with the identical result anyway.
  const chunkTexts = chunkBody(body, {summary: agentSummary});
  const rawVecs = await embedder.embedBatch(chunkTexts);
  const cleanVecs = rawVecs.filter(isAllFinite);
  if (cleanVecs.length === 0) return empty(0);

  const records = new RecordsRepository(db);
  const chunkVecs = new RecordVecRepository(db);

  // Single bulk load — mirrors find-duplicates' approach. Avoids
  // ~1000 per-record vec0 scans when the corpus is large.
  const allChunks = chunkVecs.getAllChunks();

  // Chunk-level min cosine over every record. Pure JS on the already-loaded
  // Float32Arrays — typically 5-20 chunks per side at ~50µs per pair.
  // Scored first, resolved after: `getById` is a query each, so it runs for
  // the k survivors rather than for every record compared.
  const scored: Array<{recordId: string; distance: number}> = [];
  let screened = 0;
  for (const [recordId, chunks] of allChunks) {
    if (recordId === excludeRecordId || chunks.length === 0) continue;
    ++screened;
    const distance = minPairwiseChunkDistance(cleanVecs, chunks);
    if (!Number.isFinite(distance) || distance > maxDistance) continue;
    scored.push({recordId, distance});
  }

  scored.sort((a, b) => a.distance - b.distance);
  if (scored.length > k) scored.length = k;

  const candidates: ProposeCandidate[] = [];
  for (const s of scored) {
    const rec = records.getById(s.recordId);
    if (!rec) continue;
    candidates.push({
      recordId: s.recordId,
      filePath: rec.filePath,
      distance: s.distance,
      agentSummary: rec.agentSummary
    });
  }

  return {
    candidates,
    proposedChunks: cleanVecs.length,
    candidatesScreened: screened,
    maxDistance,
    durationMs: Math.round(performance.now() - start)
  };
};
