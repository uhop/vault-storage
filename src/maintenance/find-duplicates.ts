// Pairwise vector-similarity scan that files `duplicate` suggestions for
// record pairs above a cosine-similarity threshold. Run on demand via
// `POST /maintenance/find-duplicates` or as a scheduled maintenance job.
//
// Per design constraint C16: this is deterministic work (vector math), so
// it lives in the indexer / maintenance layer, not in an agent. The agent
// reviews the filed suggestions via `/vault-review-duplicates` and decides:
// merge the two notes, keep both as related-to, treat as contradiction
// (file `contradiction_candidate`), or reject the suggestion.
//
// Idempotency: a `duplicate` suggestion of any status for the same
// unordered pair blocks re-filing, so re-running the scan is cheap and
// only adds new pairs the previous scan didn't have data for (e.g.,
// records added since).

import type {DatabaseSync} from 'node:sqlite';
import {RecordVecRepository} from '../db/vec-repo.ts';
import {DuplicateSuggestionFiler} from '../importer/file-suggestions.ts';
import {RecordsRepository} from '../records/repository.ts';

export interface FindDuplicatesOptions {
  /**
   * Cosine distance ceiling. Pairs with `distance ≤ maxDistance` are filed.
   * Default 0.10 (≥ 0.90 cosine similarity). Tighten (lower) to reduce queue
   * size; loosen (higher) to surface more potential merges at the cost of
   * agent review time.
   */
  maxDistance?: number;
  /** Per-record neighbor breadth fed into the vector index. Default 10. */
  perRecord?: number;
  /** Maximum suggestions filed in this pass; remaining pairs are deferred. */
  limit?: number;
  /** Override the timestamp written to suggestion rows (test injection). */
  now?: string;
}

export interface FindDuplicatesSummary {
  /** Records scanned (had embeddings + were neighbour-queried). */
  scanned: number;
  /** Records skipped because they have no embedding yet. */
  skippedUnembedded: number;
  /** Unique pairs above threshold encountered (post-canonicalization). */
  pairsFound: number;
  /** New `duplicate` suggestions filed. Pre-existing pairs do not refile. */
  filed: number;
  durationMs: number;
}

/**
 * Scan all embedded records for high-similarity pairs and file
 * `duplicate` suggestions. Pairs are unordered: a record's nearest
 * neighbour gets canonicalized to `(min, max)` before lookup, so each pair
 * is considered exactly once per pass.
 */
export const findDuplicates = (
  db: DatabaseSync,
  options: FindDuplicatesOptions = {}
): FindDuplicatesSummary => {
  const maxDistance = options.maxDistance ?? 0.1;
  const perRecord = options.perRecord ?? 10;
  const limit = options.limit;
  const now = options.now ?? new Date().toISOString();

  const records = new RecordsRepository(db);
  const vec = new RecordVecRepository(db);
  const filer = new DuplicateSuggestionFiler(db);

  const all = records.listAll();
  const byId = new Map<string, (typeof all)[number]>();
  for (const r of all) byId.set(r.recordId, r);

  const summary: FindDuplicatesSummary = {
    scanned: 0,
    skippedUnembedded: 0,
    pairsFound: 0,
    filed: 0,
    durationMs: 0
  };
  const start = performance.now();
  const seenPairs = new Set<string>();

  for (const r of all) {
    if (limit !== undefined && summary.filed >= limit) break;
    if (!vec.hasRecord(r.recordId)) {
      summary.skippedUnembedded++;
      continue;
    }
    summary.scanned++;
    const neighbors = vec.nearestToRecord(r.recordId, perRecord);
    for (const n of neighbors) {
      if (n.distance > maxDistance) break; // results are sorted ascending by distance
      const [aId, bId] =
        r.recordId < n.recordId ? [r.recordId, n.recordId] : [n.recordId, r.recordId];
      const key = `${aId}|${bId}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      summary.pairsFound++;
      if (limit !== undefined && summary.filed >= limit) break;
      const aRec = byId.get(aId);
      const bRec = byId.get(bId);
      if (!aRec || !bRec) continue;
      const filed = filer.fileDuplicateSuggestion({
        aRecordId: aId,
        aPath: aRec.filePath,
        bRecordId: bId,
        bPath: bRec.filePath,
        distance: n.distance,
        now
      });
      if (filed) summary.filed++;
    }
  }

  summary.durationMs = Math.round(performance.now() - start);
  return summary;
};
