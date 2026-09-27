// The chunk set of a record's body when its `agent:` block was last current
// (schema 0027). A stale refresh diffs the current chunk set against it and
// reads only the chunks that are new; the chunker keeps chunks inside their
// section, so an appended section or paragraph leaves the others' hashes intact.

import type {DatabaseSync, StatementSync} from 'node:sqlite';
import {chunkBody} from '../embeddings/chunker.ts';
import {contentHash} from '../util/hash.ts';

export interface BaselineChunk {
  hash: string;
  bytes: number;
}

export interface EnrichmentBaseline {
  bodyHash: string;
  bodyBytes: number;
  chunks: BaselineChunk[];
  created: string;
}

export interface AddedChunk {
  index: number;
  text: string;
}

export interface EnrichmentDelta {
  total: number;
  added: AddedChunk[];
  addedBytes: number;
  removed: number;
  removedBytes: number;
  /** Changed chunk bytes over the larger of the two chunk sets' byte totals. */
  changedFraction: number;
}

export const chunkBaseline = (body: string): {texts: string[]; chunks: BaselineChunk[]} => {
  const texts = chunkBody(body);
  return {
    texts,
    chunks: texts.map(text => ({hash: contentHash(text), bytes: Buffer.byteLength(text, 'utf8')}))
  };
};

export const diffBaseline = (baseline: BaselineChunk[], body: string): EnrichmentDelta => {
  const {texts, chunks} = chunkBaseline(body);
  const before = new Set(baseline.map(c => c.hash));
  const after = new Set(chunks.map(c => c.hash));
  const added: AddedChunk[] = [];
  let addedBytes = 0;
  chunks.forEach((c, index) => {
    if (before.has(c.hash)) return;
    added.push({index, text: texts[index]!});
    addedBytes += c.bytes;
  });
  let removed = 0;
  let removedBytes = 0;
  for (const c of baseline) {
    if (after.has(c.hash)) continue;
    ++removed;
    removedBytes += c.bytes;
  }
  const sum = (list: BaselineChunk[]): number => list.reduce((s, c) => s + c.bytes, 0);
  const denominator = Math.max(sum(baseline), sum(chunks), 1);
  return {
    total: chunks.length,
    added,
    addedBytes,
    removed,
    removedBytes,
    changedFraction: (addedBytes + removedBytes) / denominator
  };
};

export class EnrichmentBaselineRepository {
  readonly #get: StatementSync;
  readonly #getHash: StatementSync;
  readonly #upsert: StatementSync;

  constructor(db: DatabaseSync) {
    this.#get = db.prepare(
      'SELECT body_hash, body_bytes, chunks, created FROM enrichment_baselines WHERE record_id = ?'
    );
    this.#getHash = db.prepare('SELECT body_hash FROM enrichment_baselines WHERE record_id = ?');
    this.#upsert = db.prepare(
      `INSERT INTO enrichment_baselines (record_id, body_hash, body_bytes, chunks, created)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(record_id) DO UPDATE SET
         body_hash = excluded.body_hash, body_bytes = excluded.body_bytes,
         chunks = excluded.chunks, created = excluded.created`
    );
  }

  get(recordId: string): EnrichmentBaseline | null {
    const row = this.#get.get(recordId) as
      {body_hash: string; body_bytes: number; chunks: string; created: string} | undefined;
    if (!row) return null;
    const pairs = JSON.parse(row.chunks) as [string, number][];
    return {
      bodyHash: row.body_hash,
      bodyBytes: row.body_bytes,
      chunks: pairs.map(([hash, bytes]) => ({hash, bytes})),
      created: row.created
    };
  }

  /** Records `body` as the baseline unless it already is; true when a row was written. */
  record(recordId: string, body: string, bodyHash: string, now: string): boolean {
    const stored = this.#getHash.get(recordId) as {body_hash: string} | undefined;
    if (stored?.body_hash === bodyHash) return false;
    const {chunks} = chunkBaseline(body);
    this.#upsert.run(
      recordId,
      bodyHash,
      Buffer.byteLength(body, 'utf8'),
      JSON.stringify(chunks.map(c => [c.hash, c.bytes])),
      now
    );
    return true;
  }
}
