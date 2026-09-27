// Record an enrichment baseline (schema 0027) for every record whose `agent:`
// block is current and has none, so the first stale refresh after the
// migration already reads a delta. A record stale now has no baseline to
// recover; its next refresh reads the whole body once.

import type {DatabaseSync} from 'node:sqlite';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {EnrichmentBaselineRepository} from '../db/enrichment-baseline-repo.ts';
import {contentHash} from '../util/hash.ts';

export interface EnrichmentBaselineBackfillSummary {
  /** Enriched records with no baseline. */
  candidates: number;
  written: number;
  /** Candidates whose block is stale, or that changed since the id list was taken. */
  skipped: number;
  durationMs: number;
}

const BATCH_RECORDS = 50;

export const backfillEnrichmentBaselines = async (
  db: DatabaseSync
): Promise<EnrichmentBaselineBackfillSummary> => {
  const start = performance.now();
  const ids = (
    db
      .prepare(
        `SELECT r.record_id
           FROM records r
           LEFT JOIN enrichment_baselines b ON b.record_id = r.record_id
          WHERE r.agent_summary IS NOT NULL
            AND r.agent_derived_from_hash IS NOT NULL
            AND b.record_id IS NULL
          ORDER BY r.record_id`
      )
      .all() as {record_id: string}[]
  ).map(r => r.record_id);

  const state = db.prepare(
    `SELECT body, agent_summary, agent_derived_from_hash FROM records WHERE record_id = ?`
  );
  const baselines = new EnrichmentBaselineRepository(db);
  const now = new Date().toISOString();

  const summary: EnrichmentBaselineBackfillSummary = {
    candidates: ids.length,
    written: 0,
    skipped: 0,
    durationMs: 0
  };

  for (let offset = 0; offset < ids.length; offset += BATCH_RECORDS) {
    db.exec('BEGIN');
    try {
      for (const id of ids.slice(offset, offset + BATCH_RECORDS)) {
        const row = state.get(id) as
          | {body: string; agent_summary: string | null; agent_derived_from_hash: string | null}
          | undefined;
        if (!row?.agent_summary) {
          ++summary.skipped;
          continue;
        }
        const bodyHash = contentHash(row.body);
        if (row.agent_derived_from_hash !== bodyHash) {
          ++summary.skipped;
          continue;
        }
        baselines.record(id, row.body, bodyHash, now);
        ++summary.written;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    await nextTurn();
  }

  summary.durationMs = Math.round(performance.now() - start);
  return summary;
};
