import type {DatabaseSync, StatementSync} from 'node:sqlite';

export interface NearestHit {
  recordId: string;
  /** Cosine distance of the record's BEST chunk. 0 = identical, 2 = opposite. */
  distance: number;
}

const toBlob = (vec: Float32Array): Uint8Array =>
  new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);

/**
 * CRUD + nearest-record over the chunk embeddings. One row per chunk;
 * records may have multiple chunks. Document-level retrieval aggregates by
 * taking each record's MIN chunk distance.
 *
 * Storage is split across two tables (schema 0010):
 * - `chunks(chunk_id PK, record_id, chunk_index, content_hash)` — regular
 *   table with a B-tree index on `record_id`; all metadata lookups go here.
 * - `record_vec` — `vec0(chunk_id TEXT PK, embedding FLOAT[384])`; touched
 *   only by primary key or KNN MATCH.
 *
 * Virtual tables can't carry FK constraints; the application keeps both
 * tables in sync with records — `setChunks` replaces a record's chunks
 * atomically; `deleteRecord` mirrors record deletion; the schema-0010
 * `records_after_delete` trigger backstops every other delete path.
 */
export class RecordVecRepository {
  readonly #insertMeta: StatementSync;
  readonly #insertVec: StatementSync;
  readonly #deleteVecsByRecord: StatementSync;
  readonly #deleteMetaByRecord: StatementSync;
  readonly #hasRecord: StatementSync;
  readonly #countChunks: StatementSync;
  readonly #countRecords: StatementSync;
  readonly #getRecordHash: StatementSync;
  readonly #nearestChunks: StatementSync;
  readonly #chunksForRecord: StatementSync;
  readonly #allChunks: StatementSync;

  constructor(db: DatabaseSync) {
    this.#insertMeta = db.prepare(
      `INSERT INTO chunks (chunk_id, record_id, chunk_index, content_hash)
       VALUES (?, ?, ?, ?)`
    );
    this.#insertVec = db.prepare('INSERT INTO record_vec (chunk_id, embedding) VALUES (?, ?)');
    // Vec rows are located through chunks, so this delete must run before
    // the metadata delete (same ordering as the records_after_delete trigger).
    this.#deleteVecsByRecord = db.prepare(
      `DELETE FROM record_vec WHERE chunk_id IN (
         SELECT chunk_id FROM chunks WHERE record_id = ?
       )`
    );
    this.#deleteMetaByRecord = db.prepare('DELETE FROM chunks WHERE record_id = ?');
    this.#hasRecord = db.prepare('SELECT 1 AS x FROM chunks WHERE record_id = ? LIMIT 1');
    this.#countChunks = db.prepare('SELECT COUNT(*) AS n FROM chunks');
    this.#countRecords = db.prepare('SELECT COUNT(DISTINCT record_id) AS n FROM chunks');
    this.#getRecordHash = db.prepare('SELECT content_hash FROM chunks WHERE record_id = ? LIMIT 1');
    // KNN over the vec table, then join chunks by PK to recover record_id.
    // The KNN runs first in a subquery so the MATCH + k constraints apply
    // cleanly; the join is a B-tree point lookup per hit.
    this.#nearestChunks = db.prepare(
      `SELECT c.record_id AS record_id, k.distance AS distance
         FROM (SELECT chunk_id, distance
                 FROM record_vec
                WHERE embedding MATCH ?
                  AND k = ?
                ORDER BY distance) k
         JOIN chunks c ON c.chunk_id = k.chunk_id
        ORDER BY k.distance`
    );
    // Indexed: chunks(record_id) drives the scan; record_vec is hit by PK.
    this.#chunksForRecord = db.prepare(
      `SELECT c.chunk_index AS chunk_index, v.embedding AS embedding
         FROM chunks c
         JOIN record_vec v ON v.chunk_id = c.chunk_id
        WHERE c.record_id = ?
        ORDER BY c.chunk_index`
    );
    this.#allChunks = db.prepare(
      `SELECT c.record_id AS record_id, c.chunk_index AS chunk_index, v.embedding AS embedding
         FROM chunks c
         JOIN record_vec v ON v.chunk_id = c.chunk_id
        ORDER BY c.record_id, c.chunk_index`
    );
  }

  /**
   * Replace all chunks for a record. Atomic: deletes the existing chunks and
   * inserts the new ones. `chunks` and any per-chunk sub-arrays are zero-based;
   * `chunk_id` is composed as `${recordId}:${index}`.
   */
  setChunks(recordId: string, contentHash: string, chunks: Float32Array[]): void {
    this.#deleteVecsByRecord.run(recordId);
    this.#deleteMetaByRecord.run(recordId);
    for (let i = 0; i < chunks.length; i++) {
      const v = chunks[i]!;
      const chunkId = `${recordId}:${i}`;
      this.#insertMeta.run(chunkId, recordId, i, contentHash);
      this.#insertVec.run(chunkId, toBlob(v));
    }
  }

  /** Returns the content_hash recorded with this record's chunks, or null. */
  getRecordContentHash(recordId: string): string | null {
    const row = this.#getRecordHash.get(recordId) as Record<string, unknown> | undefined as
      {content_hash: string | null} | undefined;
    return row?.content_hash ?? null;
  }

  deleteRecord(recordId: string): boolean {
    this.#deleteVecsByRecord.run(recordId);
    return this.#deleteMetaByRecord.run(recordId).changes > 0;
  }

  hasRecord(recordId: string): boolean {
    return this.#hasRecord.get(recordId) !== undefined;
  }

  countChunks(): number {
    return (this.#countChunks.get() as Record<string, unknown> as {n: number}).n;
  }

  countRecords(): number {
    return (this.#countRecords.get() as Record<string, unknown> as {n: number}).n;
  }

  /**
   * Read all chunk vectors for a record as Float32Array views over the
   * stored blobs. L2-normalized at write time, so cosine distance against
   * any other normalized vector is `1 - dot(a, b)`.
   *
   * Used by pairwise comparisons (`find-duplicates` two-phase scan) where
   * a single per-pair chunk-min cosine is computed in JS rather than
   * issuing a sqlite-vec NN query per chunk. Indexed since schema 0010
   * (chunks.record_id B-tree + vec PK point lookups).
   */
  getChunks(recordId: string): Float32Array[] {
    const rows = this.#chunksForRecord.all(recordId) as unknown[] as {
      chunk_index: number;
      embedding: Uint8Array;
    }[];
    return rows.map(
      r => new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)
    );
  }

  /**
   * Load every record's chunks in a single pass. Keyed by `record_id`;
   * chunks within each value are ordered by `chunk_index`.
   *
   * Use this when a caller needs chunks for many records at once —
   * `find-duplicates` is the canonical case: one query instead of one
   * `getChunks()` round-trip per record.
   */
  getAllChunks(): Map<string, Float32Array[]> {
    const rows = this.#allChunks.all() as unknown[] as {
      record_id: string;
      chunk_index: number;
      embedding: Uint8Array;
    }[];
    const out = new Map<string, Float32Array[]>();
    for (const r of rows) {
      const vec = new Float32Array(
        r.embedding.buffer,
        r.embedding.byteOffset,
        r.embedding.byteLength / 4
      );
      let arr = out.get(r.record_id);
      if (arr === undefined) {
        arr = [];
        out.set(r.record_id, arr);
      }
      arr.push(vec);
    }
    return out;
  }

  /**
   * Top-k records by cosine distance, where each record's score is the
   * min-distance over its chunks. Fetches a wider chunk-level top-N (default
   * 5×k) and aggregates; `chunkK` lets a caller widen further if records
   * average many chunks.
   */
  nearest(query: Float32Array, k: number, opts: {chunkK?: number} = {}): NearestHit[] {
    const chunkK = opts.chunkK ?? Math.max(k * 5, 20);
    const rows = this.#nearestChunks.all(toBlob(query), chunkK) as unknown[] as {
      record_id: string;
      distance: number;
    }[];
    const best = new Map<string, number>();
    for (const r of rows) {
      const cur = best.get(r.record_id);
      if (cur === undefined || r.distance < cur) best.set(r.record_id, r.distance);
    }
    return [...best.entries()]
      .map(([recordId, distance]) => ({recordId, distance}))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k);
  }

  /**
   * Top-k records similar to `recordId`, computed across all of that record's
   * chunks. Aggregates by min-distance and excludes the source record itself.
   * Returns empty when the record has no chunks (not yet embedded).
   */
  nearestToRecord(recordId: string, k: number, opts: {chunkK?: number} = {}): NearestHit[] {
    const chunks = this.getChunks(recordId);
    if (chunks.length === 0) return [];

    const best = new Map<string, number>();
    const chunkK = opts.chunkK ?? Math.max(k * 5, 20);
    for (const vec of chunks) {
      const rows = this.#nearestChunks.all(toBlob(vec), chunkK) as unknown[] as {
        record_id: string;
        distance: number;
      }[];
      for (const r of rows) {
        if (r.record_id === recordId) continue;
        const cur = best.get(r.record_id);
        if (cur === undefined || r.distance < cur) best.set(r.record_id, r.distance);
      }
    }
    return [...best.entries()]
      .map(([rid, distance]) => ({recordId: rid, distance}))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k);
  }
}
