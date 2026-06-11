// Compute and store doc-level vectors for records whose chunks exist in
// `record_vec` but whose `record_doc_vec` row is missing or stale (different
// content_hash). Idempotent — running on a current vault is a no-op.
//
// Used at server startup to bring an existing DB (one that was embedded
// before doc-vec storage existed) up to current. New embeddings flow
// through `embedPending`, which writes both chunk and doc vectors in the
// same pass; backfill exists only for retroactive coverage of pre-existing
// embedded records.

import type {DatabaseSync} from 'node:sqlite';
import {meanPoolNormalize, RecordDocVecRepository} from '../db/doc-vec-repo.ts';

export interface BackfillSummary {
  /** Records with chunks in record_vec. */
  candidates: number;
  /** Records whose doc-vec was already current. */
  upToDate: number;
  /** Records whose doc-vec was computed and written. */
  written: number;
  /** Records skipped (chunks present but unparseable — should never happen). */
  skipped: number;
  durationMs: number;
}

/**
 * Walk every record that has chunk vectors and ensure a matching
 * `record_doc_vec` row exists with the same `content_hash`. Computes mean+L2
 * doc vectors from the stored chunks — no model inference needed.
 */
export const backfillDocVecs = (db: DatabaseSync): BackfillSummary => {
  const start = performance.now();
  const docVecs = new RecordDocVecRepository(db);

  // Records with at least one chunk, plus their content_hash. The chunks
  // content_hash is per-row but consistent within a record (set
  // atomically), so MAX is a safe single-row aggregator.
  const recordRows = db
    .prepare(
      `SELECT record_id, MAX(content_hash) AS content_hash
         FROM chunks
        GROUP BY record_id`
    )
    .all() as Array<{record_id: string; content_hash: string}>;

  const chunkStmt = db.prepare(
    `SELECT v.embedding AS embedding
       FROM chunks c
       JOIN record_vec v ON v.chunk_id = c.chunk_id
      WHERE c.record_id = ?
      ORDER BY c.chunk_index`
  );

  const summary: BackfillSummary = {
    candidates: recordRows.length,
    upToDate: 0,
    written: 0,
    skipped: 0,
    durationMs: 0
  };

  db.exec('BEGIN');
  try {
    for (const r of recordRows) {
      const existing = docVecs.getRecordContentHash(r.record_id);
      if (existing === r.content_hash) {
        summary.upToDate++;
        continue;
      }
      const chunkRows = chunkStmt.all(r.record_id) as Array<{embedding: Uint8Array}>;
      if (chunkRows.length === 0) {
        summary.skipped++;
        continue;
      }
      const chunks: Float32Array[] = chunkRows.map(
        c =>
          new Float32Array(c.embedding.buffer, c.embedding.byteOffset, c.embedding.byteLength / 4)
      );
      const doc = meanPoolNormalize(chunks);
      if (doc === null) {
        summary.skipped++;
        continue;
      }
      docVecs.setDocVec(r.record_id, r.content_hash, doc);
      summary.written++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  summary.durationMs = Math.round(performance.now() - start);
  return summary;
};
