// Whole-document embeddings store. One row per record, mean-pooled and
// L2-renormalized from the per-record chunk vectors in `record_vec`.
//
// Used by maintenance jobs that ask whole-document questions (find-duplicates,
// clustering, centroid queries). Chunk-level `record_vec` stays the source of
// truth for passage-level retrieval (`/sections/{id}/similar`).
//
// Distance semantics match `record_vec`: cosine, lower = more similar
// (0 = identical, 1 = orthogonal, 2 = opposite). Vectors are L2-normalized
// at write time so MIN L2 ↔ MAX cosine-similarity.

import type {DatabaseSync, StatementSync} from 'node:sqlite';

export interface DocNearestHit {
  recordId: string;
  /** Cosine distance — 0 = identical, 2 = opposite. */
  distance: number;
}

const toBlob = (vec: Float32Array): Uint8Array =>
  new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);

const isAllFinite = (v: Float32Array): boolean => {
  for (let i = 0; i < v.length; ++i) if (!Number.isFinite(v[i]!)) return false;
  return true;
};

/**
 * L2-normalize a vector in place — divides every component by the vector's
 * L2 norm. Returns the same buffer for chaining. A zero vector is returned
 * unchanged (no NaN poisoning); a vector with non-finite components is
 * zeroed out — caller is responsible for noticing that case (typically by
 * checking `isAllFinite` on its inputs first).
 */
export const l2Normalize = (vec: Float32Array): Float32Array => {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) sumSq += vec[i]! * vec[i]!;
  const norm = Math.sqrt(sumSq);
  if (!Number.isFinite(norm) || norm === 0) {
    vec.fill(0);
    return vec;
  }
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! / norm;
  return vec;
};

/**
 * Mean-pool a list of (already L2-normalized) chunk vectors into a single
 * record-level vector, then L2-renormalize. Standard document-embedding
 * recipe for BGE — preserves cosine semantics across the aggregation.
 *
 * Empty input returns null; caller decides whether to skip or treat as a
 * zero vector. (`embedPending` skips records with no chunks.)
 *
 * Non-finite chunk vectors are filtered out before pooling. A single NaN
 * chunk (BGE / transformers.js occasionally produces one on otherwise
 * normal inputs — caught 2026-05-03 with 2 of 5701 chunks affected) would
 * otherwise poison the sum and yield an all-NaN doc vector. sqlite-vec then
 * returns null distances on every neighbour query — the visible symptom
 * was 144 `duplicate` suggestions filed with `payload.distance: null`.
 * If every chunk is non-finite, returns null so the caller can skip the
 * record entirely.
 */
export const meanPoolNormalize = (chunks: Float32Array[]): Float32Array | null => {
  if (chunks.length === 0) return null;
  const finite = chunks.filter(isAllFinite);
  if (finite.length === 0) return null;
  const dim = finite[0]!.length;
  const sum = new Float32Array(dim);
  for (const c of finite) {
    for (let i = 0; i < dim; i++) sum[i] = sum[i]! + c[i]!;
  }
  return l2Normalize(sum);
};

export class RecordDocVecRepository {
  readonly #upsertDelete: StatementSync;
  readonly #insert: StatementSync;
  readonly #deleteByRecord: StatementSync;
  readonly #hasRecord: StatementSync;
  readonly #countRecords: StatementSync;
  readonly #getContentHash: StatementSync;
  readonly #getEmbedding: StatementSync;
  readonly #nearest: StatementSync;

  constructor(db: DatabaseSync) {
    // vec0 doesn't support ON CONFLICT for the PK column directly — sqlite-vec
    // virtual tables are appendable but not upsertable in one statement. Pattern:
    // delete-then-insert when refreshing.
    this.#upsertDelete = db.prepare('DELETE FROM record_doc_vec WHERE record_id = ?');
    this.#insert = db.prepare(
      'INSERT INTO record_doc_vec (record_id, content_hash, embedding) VALUES (?, ?, ?)'
    );
    this.#deleteByRecord = db.prepare('DELETE FROM record_doc_vec WHERE record_id = ?');
    this.#hasRecord = db.prepare('SELECT 1 AS x FROM record_doc_vec WHERE record_id = ?');
    this.#countRecords = db.prepare('SELECT COUNT(*) AS n FROM record_doc_vec');
    this.#getContentHash = db.prepare(
      'SELECT content_hash FROM record_doc_vec WHERE record_id = ?'
    );
    this.#getEmbedding = db.prepare('SELECT embedding FROM record_doc_vec WHERE record_id = ?');
    this.#nearest = db.prepare(
      `SELECT record_id, distance
         FROM record_doc_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance`
    );
  }

  /**
   * Replace the doc vector for a record. The vector should already be
   * L2-normalized (use `meanPoolNormalize` to compute it from chunks).
   */
  setDocVec(recordId: string, contentHash: string, vec: Float32Array): void {
    this.#upsertDelete.run(recordId);
    this.#insert.run(recordId, contentHash, toBlob(vec));
  }

  deleteRecord(recordId: string): boolean {
    return this.#deleteByRecord.run(recordId).changes > 0;
  }

  hasRecord(recordId: string): boolean {
    return this.#hasRecord.get(recordId) !== undefined;
  }

  countRecords(): number {
    return (this.#countRecords.get() as Record<string, unknown> as {n: number}).n;
  }

  getRecordContentHash(recordId: string): string | null {
    const row = this.#getContentHash.get(recordId) as {content_hash: string | null} | undefined;
    return row?.content_hash ?? null;
  }

  /** Top-K records nearest to `recordId` by doc-vector cosine, excluding self. */
  nearestToRecord(recordId: string, k: number): DocNearestHit[] {
    const own = this.#getEmbedding.get(recordId) as {embedding: Uint8Array} | undefined;
    if (!own) return [];
    // Fetch one extra candidate so self can be filtered without losing a real hit.
    const rows = this.#nearest.all(own.embedding, k + 1) as unknown[] as {
      record_id: string;
      distance: number;
    }[];
    const out: DocNearestHit[] = [];
    for (const r of rows) {
      if (r.record_id === recordId) continue;
      out.push({recordId: r.record_id, distance: r.distance});
      if (out.length >= k) break;
    }
    return out;
  }

  /** Top-K records by cosine distance to a query vector. */
  nearest(query: Float32Array, k: number): DocNearestHit[] {
    const rows = this.#nearest.all(toBlob(query), k) as unknown[] as {
      record_id: string;
      distance: number;
    }[];
    return rows.map(r => ({recordId: r.record_id, distance: r.distance}));
  }
}
