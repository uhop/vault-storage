// One vector per record for its `agent.summary` (schema 0024, D45). The
// summary is embedded on its own, so a summary refresh embeds one text and
// leaves the chunk vectors in `record_vec` untouched. Hashes live in
// `record_summaries`, vectors in the `record_summary_vec` vec0 table, which is
// touched only by primary key or KNN.

import type {DatabaseSync, StatementSync} from 'node:sqlite';

export interface StoredSummaryVec {
  /** The record's content_hash when this vector was written. */
  contentHash: string;
  /** Hash of the summary text embedded; null when the vector is not reusable. */
  textHash: string | null;
  embedding: Float32Array;
}

export interface SummaryNearestHit {
  recordId: string;
  /** L2 distance between unit vectors, as sqlite-vec reports it. */
  distance: number;
}

const toBlob = (vec: Float32Array): Uint8Array =>
  new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);

const toVector = (blob: Uint8Array): Float32Array => {
  const bytes = blob.slice();
  return new Float32Array(bytes.buffer, 0, bytes.byteLength / 4);
};

export class RecordSummaryVecRepository {
  readonly #deleteVec: StatementSync;
  readonly #deleteMeta: StatementSync;
  readonly #insertVec: StatementSync;
  readonly #insertMeta: StatementSync;
  readonly #get: StatementSync;
  readonly #nearest: StatementSync;
  readonly #count: StatementSync;

  constructor(db: DatabaseSync) {
    // vec0 has no upsert: refresh is delete-then-insert.
    this.#deleteVec = db.prepare('DELETE FROM record_summary_vec WHERE record_id = ?');
    this.#deleteMeta = db.prepare('DELETE FROM record_summaries WHERE record_id = ?');
    this.#insertVec = db.prepare(
      'INSERT INTO record_summary_vec (record_id, embedding) VALUES (?, ?)'
    );
    this.#insertMeta = db.prepare(
      'INSERT INTO record_summaries (record_id, content_hash, text_hash) VALUES (?, ?, ?)'
    );
    this.#get = db.prepare(
      `SELECT s.content_hash, s.text_hash, v.embedding
         FROM record_summaries s
         JOIN record_summary_vec v ON v.record_id = s.record_id
        WHERE s.record_id = ?`
    );
    this.#nearest = db.prepare(
      `SELECT record_id, distance
         FROM record_summary_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance`
    );
    this.#count = db.prepare('SELECT COUNT(*) AS n FROM record_summaries');
  }

  set(recordId: string, contentHash: string, textHash: string | null, vec: Float32Array): void {
    this.delete(recordId);
    this.#insertMeta.run(recordId, contentHash, textHash);
    this.#insertVec.run(recordId, toBlob(vec));
  }

  delete(recordId: string): boolean {
    this.#deleteVec.run(recordId);
    return this.#deleteMeta.run(recordId).changes > 0;
  }

  get(recordId: string): StoredSummaryVec | null {
    const row = this.#get.get(recordId) as
      {content_hash: string; text_hash: string | null; embedding: Uint8Array} | undefined;
    if (!row) return null;
    return {
      contentHash: row.content_hash,
      textHash: row.text_hash,
      embedding: toVector(row.embedding)
    };
  }

  nearest(query: Float32Array, k: number): SummaryNearestHit[] {
    const rows = this.#nearest.all(toBlob(query), k) as unknown[] as {
      record_id: string;
      distance: number;
    }[];
    return rows.map(r => ({recordId: r.record_id, distance: r.distance}));
  }

  count(): number {
    return (this.#count.get() as {n: number}).n;
  }
}
