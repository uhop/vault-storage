import type {DatabaseSync, StatementSync} from 'node:sqlite';

export interface NearestHit {
  recordId: string;
  /** Cosine distance: 0 = identical direction, 2 = opposite. Lower = more similar. */
  distance: number;
}

const toBlob = (vec: Float32Array): Uint8Array =>
  new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);

/**
 * CRUD + nearest-neighbor over the `record_vec` virtual table (sqlite-vec).
 * Schema: `vec0(record_id TEXT PRIMARY KEY, embedding FLOAT[384])`. The
 * application keeps record_vec in sync with records — virtual tables can't
 * carry FK constraints, so insert/delete here mirrors records.
 */
export class RecordVecRepository {
  readonly #insert: StatementSync;
  readonly #delete: StatementSync;
  readonly #has: StatementSync;
  readonly #count: StatementSync;
  readonly #getHash: StatementSync;
  readonly #nearest: StatementSync;

  constructor(db: DatabaseSync) {
    this.#insert = db.prepare(
      'INSERT INTO record_vec (record_id, content_hash, embedding) VALUES (?, ?, ?)'
    );
    this.#delete = db.prepare('DELETE FROM record_vec WHERE record_id = ?');
    this.#has = db.prepare('SELECT 1 AS x FROM record_vec WHERE record_id = ? LIMIT 1');
    this.#count = db.prepare('SELECT COUNT(*) AS n FROM record_vec');
    this.#getHash = db.prepare('SELECT content_hash FROM record_vec WHERE record_id = ? LIMIT 1');
    this.#nearest = db.prepare(
      `SELECT record_id, distance
         FROM record_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance`
    );
  }

  insert(recordId: string, contentHash: string, vec: Float32Array): void {
    this.#insert.run(recordId, contentHash, toBlob(vec));
  }

  /**
   * sqlite-vec virtual tables don't support UPSERT — emulate by DELETE + INSERT.
   * Wrap in a transaction at the call site if atomicity matters across many rows.
   */
  upsert(recordId: string, contentHash: string, vec: Float32Array): void {
    this.#delete.run(recordId);
    this.#insert.run(recordId, contentHash, toBlob(vec));
  }

  /** Returns the content_hash recorded with the vector, or null if none. */
  getContentHash(recordId: string): string | null {
    const row = this.#getHash.get(recordId) as Record<string, unknown> | undefined as
      | {content_hash: string | null}
      | undefined;
    return row?.content_hash ?? null;
  }

  delete(recordId: string): boolean {
    return this.#delete.run(recordId).changes > 0;
  }

  has(recordId: string): boolean {
    return this.#has.get(recordId) !== undefined;
  }

  count(): number {
    const row = this.#count.get() as Record<string, unknown> as {n: number};
    return row.n;
  }

  /** Top-k nearest by cosine distance. Self-matches included unless caller filters. */
  nearest(query: Float32Array, k: number): NearestHit[] {
    return (
      this.#nearest.all(toBlob(query), k) as unknown[] as {
        record_id: string;
        distance: number;
      }[]
    ).map(r => ({recordId: r.record_id, distance: r.distance}));
  }
}
