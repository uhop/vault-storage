import type {DatabaseSync, StatementSync} from 'node:sqlite';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {bumpChunkVersion, chunkMatrix, DIM, type ChunkMatrix} from './chunk-matrix.ts';
import {RecordSummaryVecRepository} from './summary-vec-repo.ts';

export interface NearestHit {
  recordId: string;
  /**
   * L2 distance between unit vectors, 0 = identical, 2 = opposite: of the best
   * chunk from `nearestToRecord`, of {@link recordSimilarity} from `nearest`.
   */
  distance: number;
  /** Index of the record's best chunk — resolves to text via `chunkBody(body)[chunkIndex]`. */
  chunkIndex: number;
}

const toBlob = (vec: Float32Array): Uint8Array =>
  new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);

/**
 * A record's similarity to a query: the better of its best chunk and, when it
 * has one, its summary. Max over a 0.6/0.4 blend keeps a large note findable by
 * one passage its summary does not describe (D45, `eval/embedding-summary-query-ab.ts`).
 */
export const recordSimilarity = (bestChunk: number, summary: number | null): number =>
  summary === null ? bestChunk : Math.max(bestChunk, summary);

// Unit vectors: L2² = 2 − 2·cosine.
const similarityOf = (distance: number): number => 1 - (distance * distance) / 2;
const distanceOf = (similarity: number): number => Math.sqrt(Math.max(0, 2 - 2 * similarity));

const dot = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; ++i) s += a[i]! * b[i]!;
  return s;
};

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
  readonly #db: DatabaseSync;
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
  readonly #vectorsByTextHash: StatementSync;
  readonly #summaries: RecordSummaryVecRepository;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#summaries = new RecordSummaryVecRepository(db);
    this.#insertMeta = db.prepare(
      `INSERT INTO chunks (chunk_id, record_id, chunk_index, content_hash, text_hash)
       VALUES (?, ?, ?, ?, ?)`
    );
    this.#vectorsByTextHash = db.prepare(
      `SELECT c.text_hash AS text_hash, v.embedding AS embedding
         FROM chunks c
         JOIN record_vec v ON v.chunk_id = c.chunk_id
        WHERE c.record_id = ? AND c.text_hash IS NOT NULL`
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
      `SELECT c.record_id AS record_id, c.chunk_index AS chunk_index, k.distance AS distance
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
  setChunks(
    recordId: string,
    contentHash: string,
    chunks: Float32Array[],
    textHashes: readonly (string | null)[] = []
  ): void {
    this.#deleteVecsByRecord.run(recordId);
    this.#deleteMetaByRecord.run(recordId);
    for (let i = 0; i < chunks.length; i++) {
      const v = chunks[i]!;
      const chunkId = `${recordId}:${i}`;
      this.#insertMeta.run(chunkId, recordId, i, contentHash, textHashes[i] ?? null);
      this.#insertVec.run(chunkId, toBlob(v));
    }
    bumpChunkVersion(this.#db);
  }

  /** A record's stored vectors keyed by the hash of the chunk text they embed; chunks without a hash are left out. */
  getVectorsByTextHash(recordId: string): Map<string, Float32Array> {
    const rows = this.#vectorsByTextHash.all(recordId) as unknown[] as {
      text_hash: string;
      embedding: Uint8Array;
    }[];
    const out = new Map<string, Float32Array>();
    for (const r of rows) {
      out.set(
        r.text_hash,
        new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4)
      );
    }
    return out;
  }

  /** Returns the content_hash recorded with this record's chunks, or null. */
  getRecordContentHash(recordId: string): string | null {
    const row = this.#getRecordHash.get(recordId) as Record<string, unknown> | undefined as
      {content_hash: string | null} | undefined;
    return row?.content_hash ?? null;
  }

  deleteRecord(recordId: string): boolean {
    this.#deleteVecsByRecord.run(recordId);
    bumpChunkVersion(this.#db);
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
   * Top-k records by {@link recordSimilarity} to a query, exact. Every chunk
   * is scored in one pass over the chunk matrix (D78), so each record's best
   * chunk is known. A record in the top k by the better of chunk and summary
   * is in the top k by chunk or the top k by summary, so the summary KNN only
   * has to reach k records that have chunks; the union is ranked.
   */
  async nearest(
    query: Float32Array,
    k: number,
    opts: {blockRows?: number} = {}
  ): Promise<NearestHit[]> {
    const {matrix, best, bestRow} = await this.#scan(query, 1, null, opts.blockRows);
    const byChunk: number[] = [];
    for (let o = 0; o < matrix.ids.length; ++o) if (bestRow[o]! >= 0) byChunk.push(o);
    byChunk.sort((a, b) => best[a]! - best[b]!);

    const summaries = new Map<string, number>();
    for (let summaryK = Math.max(k * 2, 20); ; summaryK *= 4) {
      const rows = this.#summaries.nearest(query, summaryK);
      summaries.clear();
      for (const r of rows) {
        if (Number.isFinite(r.distance) && matrix.idOf.has(r.recordId))
          summaries.set(r.recordId, similarityOf(r.distance));
      }
      if (summaries.size >= k || rows.length < summaryK) break;
    }

    const candidates = new Set<number>(byChunk.slice(0, k));
    for (const recordId of [...summaries.keys()].slice(0, k))
      candidates.add(matrix.idOf.get(recordId)!);
    return [...candidates]
      .map(o => {
        const recordId = matrix.ids[o]!;
        const summary = summaries.get(recordId) ?? this.#summarySimilarity(recordId, query);
        const similarity = recordSimilarity(1 - best[o]! / 2, summary);
        return {
          recordId,
          distance: distanceOf(similarity),
          chunkIndex: matrix.chunkIndex[bestRow[o]!]!
        };
      })
      .sort((a, b) => a.distance - b.distance)
      .slice(0, k);
  }

  /**
   * One pass over the chunk matrix scoring `m` packed query vectors: each
   * record's smallest squared L2 distance to any of them and the row it came
   * from. The rows of `skipRecordId` are passed over. It yields every
   * `blockRows` rows, by default as many as keep a block to 32K row-query
   * scores (2,048 rows at 16 query chunks, about 50 ms on nuke).
   */
  async #scan(
    queries: Float32Array,
    m: number,
    skipRecordId: string | null,
    blockRows = Math.max(1, Math.floor(32_768 / m))
  ): Promise<{matrix: ChunkMatrix; best: Float64Array; bestRow: Int32Array}> {
    const matrix = await chunkMatrix(this.#db);
    const {n, data, owner, ids} = matrix;
    const skip = skipRecordId === null ? -1 : (matrix.idOf.get(skipRecordId) ?? -1);
    const best = new Float64Array(ids.length).fill(Infinity);
    const bestRow = new Int32Array(ids.length).fill(-1);
    for (let row = 0; row < n; ++row) {
      if (row > 0 && row % blockRows === 0) await nextTurn();
      const o = owner[row]!;
      if (o === skip) continue;
      const base = row * DIM;
      for (let q = 0; q < m; ++q) {
        const qb = q * DIM;
        let sum = 0;
        for (let d = 0; d < DIM; ++d) {
          const diff = queries[qb + d]! - data[base + d]!;
          sum += diff * diff;
        }
        if (sum < best[o]!) {
          best[o] = sum;
          bestRow[o] = row;
        }
      }
    }
    return {matrix, best, bestRow};
  }

  #summarySimilarity(recordId: string, query: Float32Array): number | null {
    const stored = this.#summaries.get(recordId);
    if (!stored) return null;
    const similarity = dot(stored.embedding, query);
    return Number.isFinite(similarity) ? similarity : null;
  }

  /**
   * Top-k records similar to `recordId`, computed across that record's
   * chunks. Aggregates by min-distance and excludes the source record itself.
   * Returns empty when the record has no chunks (not yet embedded).
   *
   * Query chunks are capped at `maxScans` (default 64), sampled evenly across
   * the record with the first and last always kept: a 1,671-chunk running
   * file scored with every chunk took 26 s. Top-15 recall against every chunk
   * was 74% at 16 and 98% at 64 over records of 17–133 chunks (D78). The query chunks are scored in one
   * exact pass over every stored chunk vector (the cached matrix, D78),
   * yielding to the event loop every `blockRows` rows. Sixteen sqlite-vec KNN
   * scans did this before, one per query chunk, each with a top-`k` window a
   * few large records could fill, so a small record lost real neighbours.
   */
  async nearestToRecord(
    recordId: string,
    k: number,
    opts: {maxScans?: number; blockRows?: number} = {}
  ): Promise<NearestHit[]> {
    const allChunks = this.getChunks(recordId);
    if (allChunks.length === 0) return [];

    const maxScans = Math.max(1, opts.maxScans ?? 64);
    let chunks = allChunks;
    if (allChunks.length > maxScans) {
      chunks = [];
      const step = maxScans > 1 ? (allChunks.length - 1) / (maxScans - 1) : 0;
      let last = -1;
      for (let i = 0; i < maxScans; ++i) {
        const index = Math.round(i * step);
        if (index === last) continue;
        last = index;
        chunks.push(allChunks[index]!);
      }
    }
    const m = chunks.length;
    const queries = new Float32Array(m * DIM);
    chunks.forEach((v, i) => queries.set(v, i * DIM));

    const {matrix, best, bestRow} = await this.#scan(queries, m, recordId, opts.blockRows);
    const {chunkIndex, ids} = matrix;

    const hits: NearestHit[] = [];
    for (let o = 0; o < ids.length; ++o) {
      const row = bestRow[o]!;
      if (row >= 0)
        hits.push({recordId: ids[o]!, distance: Math.sqrt(best[o]!), chunkIndex: chunkIndex[row]!});
    }
    return hits.sort((a, b) => a.distance - b.distance).slice(0, k);
  }
}
