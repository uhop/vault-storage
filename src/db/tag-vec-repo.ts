// One vector per taxonomy tag (schema 0030), embedded from the tag's name and
// description for the nearest-tag lookup. Hashes live in `tag_vec_meta`,
// vectors in the `tag_vec` vec0 table, touched only by primary key or KNN.

import type {DatabaseSync, StatementSync} from 'node:sqlite';

export interface TagNearestHit {
  tag: string;
  /** L2 distance between unit vectors, as sqlite-vec reports it. */
  distance: number;
}

const toBlob = (vec: Float32Array): Uint8Array =>
  new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);

const toVector = (blob: Uint8Array): Float32Array => {
  const bytes = blob.slice();
  return new Float32Array(bytes.buffer, 0, bytes.byteLength / 4);
};

export class TagVecRepository {
  readonly #deleteVec: StatementSync;
  readonly #deleteMeta: StatementSync;
  readonly #insertVec: StatementSync;
  readonly #insertMeta: StatementSync;
  readonly #get: StatementSync;
  readonly #hashes: StatementSync;
  readonly #nearest: StatementSync;
  readonly #count: StatementSync;

  constructor(db: DatabaseSync) {
    // vec0 has no upsert: refresh is delete-then-insert.
    this.#deleteVec = db.prepare('DELETE FROM tag_vec WHERE tag = ?');
    this.#deleteMeta = db.prepare('DELETE FROM tag_vec_meta WHERE tag = ?');
    this.#insertVec = db.prepare('INSERT INTO tag_vec (tag, embedding) VALUES (?, ?)');
    this.#insertMeta = db.prepare('INSERT INTO tag_vec_meta (tag, text_hash) VALUES (?, ?)');
    this.#get = db.prepare('SELECT embedding FROM tag_vec WHERE tag = ?');
    this.#hashes = db.prepare('SELECT tag, text_hash FROM tag_vec_meta');
    this.#nearest = db.prepare(
      `SELECT tag, distance
         FROM tag_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance`
    );
    this.#count = db.prepare('SELECT COUNT(*) AS n FROM tag_vec_meta');
  }

  set(tag: string, textHash: string, vec: Float32Array): void {
    this.delete(tag);
    this.#insertMeta.run(tag, textHash);
    this.#insertVec.run(tag, toBlob(vec));
  }

  delete(tag: string): boolean {
    this.#deleteVec.run(tag);
    return this.#deleteMeta.run(tag).changes > 0;
  }

  get(tag: string): Float32Array | null {
    const row = this.#get.get(tag) as {embedding: Uint8Array} | undefined;
    return row ? toVector(row.embedding) : null;
  }

  /** tag → hash of the text its stored vector came from. */
  hashes(): Map<string, string> {
    const rows = this.#hashes.all() as unknown[] as {tag: string; text_hash: string}[];
    return new Map(rows.map(r => [r.tag, r.text_hash]));
  }

  nearest(query: Float32Array, k: number): TagNearestHit[] {
    const rows = this.#nearest.all(toBlob(query), k) as unknown[] as {
      tag: string;
      distance: number;
    }[];
    return rows.map(r => ({tag: r.tag, distance: r.distance}));
  }

  count(): number {
    return (this.#count.get() as {n: number}).n;
  }
}
