import type {DatabaseSync, StatementSync} from 'node:sqlite';

export interface NearestHit {
  recordId: string;
  /** Cosine distance of the record's BEST chunk. 0 = identical, 2 = opposite. */
  distance: number;
}

const toBlob = (vec: Float32Array): Uint8Array =>
  new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);

/**
 * CRUD + nearest-record over the chunked `record_vec` virtual table. One row
 * per chunk; records may have multiple chunks. Document-level retrieval
 * aggregates by taking each record's MIN chunk distance.
 *
 * Schema: `vec0(chunk_id TEXT PK, +record_id, +chunk_index, +content_hash, embedding FLOAT[384])`.
 * Virtual tables can't carry FK constraints; the application keeps record_vec
 * in sync with records — `setChunks` replaces a record's chunks atomically;
 * `deleteRecord` mirrors record deletion.
 */
export class RecordVecRepository {
  readonly #insert: StatementSync;
  readonly #deleteByRecord: StatementSync;
  readonly #hasRecord: StatementSync;
  readonly #countChunks: StatementSync;
  readonly #countRecords: StatementSync;
  readonly #getRecordHash: StatementSync;
  readonly #nearestChunks: StatementSync;
  readonly #chunksForRecord: StatementSync;

  constructor(db: DatabaseSync) {
    this.#insert = db.prepare(
      `INSERT INTO record_vec (chunk_id, record_id, chunk_index, content_hash, embedding)
       VALUES (?, ?, ?, ?, ?)`
    );
    this.#deleteByRecord = db.prepare('DELETE FROM record_vec WHERE record_id = ?');
    this.#hasRecord = db.prepare('SELECT 1 AS x FROM record_vec WHERE record_id = ? LIMIT 1');
    this.#countChunks = db.prepare('SELECT COUNT(*) AS n FROM record_vec');
    this.#countRecords = db.prepare('SELECT COUNT(DISTINCT record_id) AS n FROM record_vec');
    this.#getRecordHash = db.prepare(
      'SELECT content_hash FROM record_vec WHERE record_id = ? LIMIT 1'
    );
    // Pull a wider chunk-level top-N then aggregate to records by min distance.
    // Caller tunes the chunk-fetch breadth via `chunkK` (default 5×k upstream).
    this.#nearestChunks = db.prepare(
      `SELECT record_id, distance
         FROM record_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance`
    );
    this.#chunksForRecord = db.prepare(
      `SELECT chunk_index, embedding FROM record_vec
        WHERE record_id = ?
        ORDER BY chunk_index`
    );
  }

  /**
   * Replace all chunks for a record. Atomic: deletes the existing chunks and
   * inserts the new ones. `chunks` and any per-chunk sub-arrays are zero-based;
   * `chunk_id` is composed as `${recordId}:${index}`.
   */
  setChunks(recordId: string, contentHash: string, chunks: Float32Array[]): void {
    this.#deleteByRecord.run(recordId);
    for (let i = 0; i < chunks.length; i++) {
      const v = chunks[i]!;
      // sqlite-vec aux INTEGER columns reject JS number — pass BigInt explicitly.
      this.#insert.run(`${recordId}:${i}`, recordId, BigInt(i), contentHash, toBlob(v));
    }
  }

  /** Returns the content_hash recorded with this record's chunks, or null. */
  getRecordContentHash(recordId: string): string | null {
    const row = this.#getRecordHash.get(recordId) as Record<string, unknown> | undefined as
      | {content_hash: string | null}
      | undefined;
    return row?.content_hash ?? null;
  }

  deleteRecord(recordId: string): boolean {
    return this.#deleteByRecord.run(recordId).changes > 0;
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
    const chunks = this.#chunksForRecord.all(recordId) as unknown[] as {
      chunk_index: number;
      embedding: Uint8Array;
    }[];
    if (chunks.length === 0) return [];

    const best = new Map<string, number>();
    const chunkK = opts.chunkK ?? Math.max(k * 5, 20);
    for (const chunk of chunks) {
      // record_vec stores embeddings as raw float32 little-endian blobs.
      const vec = new Float32Array(
        chunk.embedding.buffer,
        chunk.embedding.byteOffset,
        chunk.embedding.byteLength / 4
      );
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
