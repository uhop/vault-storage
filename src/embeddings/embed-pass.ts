import type {DatabaseSync} from 'node:sqlite';
import {RecordVecRepository} from '../db/vec-repo.ts';
import type {Embedder} from './types.ts';

export interface EmbedSummary {
  /** Vectors written this pass (new + refreshed). */
  embedded: number;
  /** Records skipped because vector + content_hash already match. */
  upToDate: number;
  /** Total records inspected. */
  total: number;
  durationMs: number;
}

const DEFAULT_BATCH_SIZE = 32;

interface PendingRow {
  record_id: string;
  body: string;
  content_hash: string;
}

/**
 * Compute embeddings for every record whose vector is missing or whose
 * content_hash no longer matches the record's body. Idempotent: a second run
 * over an unchanged vault embeds nothing.
 *
 * Embedding runs **outside** the SQLite transaction (it's async); the upsert
 * then writes within a per-batch transaction so the DB is consistent at every
 * commit boundary.
 */
export const embedPending = async (
  db: DatabaseSync,
  embedder: Embedder,
  options: {batchSize?: number} = {}
): Promise<EmbedSummary> => {
  const start = performance.now();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const totalRow = db.prepare('SELECT COUNT(*) AS n FROM records').get() as Record<
    string,
    unknown
  > as {n: number};
  const total = totalRow.n;

  const pendingStmt = db.prepare(
    `SELECT r.record_id, r.body, r.content_hash
       FROM records r
       LEFT JOIN record_vec v ON v.record_id = r.record_id
      WHERE v.record_id IS NULL
         OR v.content_hash IS NULL
         OR v.content_hash != r.content_hash
      ORDER BY r.record_id`
  );
  const pending = pendingStmt.all() as unknown[] as PendingRow[];

  const vecs = new RecordVecRepository(db);
  let embedded = 0;

  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const vectors = await embedder.embedBatch(batch.map(r => r.body));

    db.exec('BEGIN');
    try {
      for (let j = 0; j < batch.length; j++) {
        const row = batch[j]!;
        const vec = vectors[j];
        if (!vec) continue;
        vecs.upsert(row.record_id, row.content_hash, vec);
        embedded++;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    embedded,
    upToDate: total - embedded,
    total,
    durationMs: Math.round(performance.now() - start)
  };
};
