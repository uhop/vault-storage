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
// chunk pairs); the propose path adds a doc-level prefilter so an
// arbitrary body can be scored against a few-thousand-record vault in
// the millisecond range plus the embedding cost (~100-500ms BGE).
//
// `excludeRecordId` removes the target's own existing record when
// updating an existing path — without it, a tiny FM-only edit would
// always self-match at distance ≈ 0.

import type {DatabaseSync} from 'node:sqlite';
import {meanPoolNormalize, RecordDocVecRepository} from '../db/doc-vec-repo.ts';
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
   * Doc-level prefilter ceiling (L2 distance on the mean-pool centroid).
   * Default 0.50 — wider than find-duplicates' 0.30 because propose is
   * a search-before-write surface and the caller wants to see the full
   * neighborhood, not just confirmed duplicates.
   */
  prefilterMaxDistance?: number;
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
  /** Records considered after the doc-level prefilter. */
  candidatesScreened: number;
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
 * Embed the proposed body and return its top-K nearest existing records.
 * Two-phase: doc-level mean-pool prefilter (cheap, wide) followed by
 * chunk-level min cosine on survivors (precise). Returns candidates
 * sorted by ascending distance — caller decides what threshold means
 * "too close to write" for their use case.
 */
export const proposeNearest = async (
  db: DatabaseSync,
  embedder: Embedder,
  body: string,
  agentSummary: string | null,
  options: ProposeOptions = {}
): Promise<ProposeResult> => {
  const k = options.k ?? 10;
  const prefilterMaxDistance = options.prefilterMaxDistance ?? 0.5;
  const excludeRecordId = options.excludeRecordId;

  const start = performance.now();

  const chunkTexts = chunkBody(body, {summary: agentSummary});
  if (chunkTexts.length === 0) {
    return {
      candidates: [],
      proposedChunks: 0,
      candidatesScreened: 0,
      durationMs: Math.round(performance.now() - start)
    };
  }

  const rawVecs = await embedder.embedBatch(chunkTexts);
  const cleanVecs = rawVecs.filter(isAllFinite);
  if (cleanVecs.length === 0) {
    return {
      candidates: [],
      proposedChunks: 0,
      candidatesScreened: 0,
      durationMs: Math.round(performance.now() - start)
    };
  }
  const proposedCentroid = meanPoolNormalize(cleanVecs);
  if (proposedCentroid === null) {
    return {
      candidates: [],
      proposedChunks: cleanVecs.length,
      candidatesScreened: 0,
      durationMs: Math.round(performance.now() - start)
    };
  }

  const records = new RecordsRepository(db);
  const docVecs = new RecordDocVecRepository(db);
  const chunkVecs = new RecordVecRepository(db);

  // Single bulk load each — mirrors find-duplicates' approach. Avoids
  // ~1000 per-record vec0 scans when the corpus is large.
  const allDocVecs = docVecs.getAllDocVecs();
  const allChunks = chunkVecs.getAllChunks();

  // Phase 1: doc-level prefilter. L2² on the mean-pool centroid against
  // every existing doc vector. Threshold matches sqlite-vec's L2 metric
  // (vec0 with FLOAT[N] columns and no explicit distance_metric returns
  // L2 — see find-duplicates.ts line ~218 for the empirical pin).
  const dim = proposedCentroid.length;
  const prefilterL2Sq = prefilterMaxDistance * prefilterMaxDistance;
  const survivors: Array<{recordId: string}> = [];
  for (const [otherId, otherVec] of allDocVecs) {
    if (otherId === excludeRecordId) continue;
    let l2sq = 0;
    for (let i = 0; i < dim; ++i) {
      const d = proposedCentroid[i]! - otherVec[i]!;
      l2sq += d * d;
    }
    if (!Number.isFinite(l2sq) || l2sq > prefilterL2Sq) continue;
    survivors.push({recordId: otherId});
  }

  // Phase 2: chunk-level min cosine on survivors. Pure JS over the
  // already-loaded Float32Arrays — typically 5-20 chunks per side at
  // ~50µs per pair.
  const candidates: ProposeCandidate[] = [];
  for (const s of survivors) {
    const chunks = allChunks.get(s.recordId);
    if (!chunks || chunks.length === 0) continue;
    const distance = minPairwiseChunkDistance(cleanVecs, chunks);
    if (!Number.isFinite(distance)) continue;
    const rec = records.getById(s.recordId);
    if (!rec) continue;
    candidates.push({
      recordId: s.recordId,
      filePath: rec.filePath,
      distance,
      agentSummary: rec.agentSummary
    });
  }

  candidates.sort((a, b) => a.distance - b.distance);
  if (candidates.length > k) candidates.length = k;

  return {
    candidates,
    proposedChunks: cleanVecs.length,
    candidatesScreened: survivors.length,
    durationMs: Math.round(performance.now() - start)
  };
};
