// Every chunk vector in one Float32Array, for scoring many query chunks in a
// single pass (D78). Sixteen sqlite-vec KNN scans per `/similar` call cost
// about 170 ms each on a 28K-chunk vault; one pass over the matrix scores the
// same sixteen in about 250 ms, exactly.
//
// A snapshot is immutable: a vector write bumps the database's version and
// the next reader builds a new one, so a pass that yields mid-way never sees
// the matrix change under it. The build pages the `chunks` join by rowid and
// yields between pages. Records deleted by the SQL trigger or the orphan
// cleanup do not bump the version: their rows stay until the next build, and
// callers drop hits whose record is gone.

import type {DatabaseSync} from 'node:sqlite';
import {setImmediate as nextTurn} from 'node:timers/promises';

export const DIM = 384;
const PAGE_ROWS = 2048;

export interface ChunkMatrix {
  n: number;
  data: Float32Array;
  /** Index into `ids` of each row's record. */
  owner: Int32Array;
  chunkIndex: Int32Array;
  ids: string[];
  idOf: Map<string, number>;
}

interface Cache {
  version: number;
  snapshot?: {version: number; count: number; matrix: ChunkMatrix};
  building?: {version: number; promise: Promise<ChunkMatrix>};
}

const caches = new WeakMap<DatabaseSync, Cache>();

const cacheOf = (db: DatabaseSync): Cache => {
  let cache = caches.get(db);
  if (!cache) caches.set(db, (cache = {version: 0}));
  return cache;
};

/** Mark the matrix stale after a vector write. */
export const bumpChunkVersion = (db: DatabaseSync): void => {
  ++cacheOf(db).version;
};

const build = async (db: DatabaseSync, count: number): Promise<ChunkMatrix> => {
  const page = db.prepare(
    `SELECT c.rowid AS r, c.record_id AS record_id, c.chunk_index AS chunk_index,
            v.embedding AS embedding
       FROM chunks c JOIN record_vec v ON v.chunk_id = c.chunk_id
      WHERE c.rowid > ? ORDER BY c.rowid LIMIT ${PAGE_ROWS}`
  );
  // Sized from the count up front and filled page by page, so each page's row
  // buffers can go as soon as they are copied; rows added while it yields grow it.
  let capacity = count + PAGE_ROWS;
  let data = new Float32Array(capacity * DIM);
  let owner = new Int32Array(capacity);
  let chunkIndex = new Int32Array(capacity);
  const ids: string[] = [];
  const idOf = new Map<string, number>();
  let n = 0;
  for (let last = 0; ;) {
    const rows = page.all(last) as unknown[] as {
      r: number;
      record_id: string;
      chunk_index: number;
      embedding: Uint8Array;
    }[];
    if (!rows.length) break;
    if (n + rows.length > capacity) {
      capacity = Math.ceil((n + rows.length) * 1.5);
      data = grow(data, capacity * DIM);
      owner = grow(owner, capacity);
      chunkIndex = grow(chunkIndex, capacity);
    }
    for (const row of rows) {
      let o = idOf.get(row.record_id);
      if (o === undefined) {
        o = ids.length;
        ids.push(row.record_id);
        idOf.set(row.record_id, o);
      }
      data.set(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, DIM), n * DIM);
      owner[n] = o;
      chunkIndex[n] = row.chunk_index;
      ++n;
    }
    last = rows[rows.length - 1]!.r;
    await nextTurn();
  }
  return {
    n,
    data: data.subarray(0, n * DIM),
    owner: owner.subarray(0, n),
    chunkIndex: chunkIndex.subarray(0, n),
    ids,
    idOf
  };
};

const grow = <T extends Float32Array | Int32Array>(array: T, length: number): T => {
  const next = new (array.constructor as new (length: number) => T)(length);
  next.set(array);
  return next;
};

/** Whether the matrix a reader would get is built already: `rows` is the built snapshot's size, null when none. */
export const chunkMatrixStatus = (
  db: DatabaseSync
): {warm: boolean; rows: number | null; building: boolean} => {
  const cache = cacheOf(db);
  const count = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as {n: number}).n;
  const {snapshot} = cache;
  const warm =
    snapshot !== undefined && snapshot.version === cache.version && snapshot.count === count;
  return {
    warm,
    rows: snapshot ? snapshot.matrix.n : null,
    building: cache.building?.version === cache.version
  };
};

/**
 * Build the matrix now, off any request, so the next reader finds it built
 * instead of paying the rebuild (D87). A reader arriving meanwhile shares the
 * build. Failures go to `report`, never to a caller.
 */
export const warmChunkMatrix = (
  db: DatabaseSync,
  report: (err: unknown) => void = () => {}
): void => {
  chunkMatrix(db).then(() => {}, report);
};

/** The current matrix, built on first use and after any vector write. */
export const chunkMatrix = async (db: DatabaseSync): Promise<ChunkMatrix> => {
  const cache = cacheOf(db);
  const count = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as {n: number}).n;
  const {snapshot} = cache;
  if (snapshot && snapshot.version === cache.version && snapshot.count === count)
    return snapshot.matrix;
  if (cache.building?.version === cache.version) return cache.building.promise;
  const version = cache.version;
  const promise = build(db, count);
  cache.building = {version, promise};
  try {
    const matrix = await promise;
    cache.snapshot = {version, count, matrix};
    return matrix;
  } finally {
    if (cache.building?.promise === promise) delete cache.building;
  }
};
