import type {DatabaseSync} from 'node:sqlite';
import {TagVecRepository} from '../db/tag-vec-repo.ts';
import {contentHash} from '../util/hash.ts';
import type {Embedder} from './types.ts';

export interface TagEmbedSummary {
  /** Tags embedded this pass: new, re-described, or retried. */
  embedded: number;
  /** Tags whose stored vector already matched their text. */
  upToDate: number;
  /** Taxonomy tags inspected. */
  total: number;
  durationMs: number;
}

/** The text a tag is embedded from: its name as words, then its description when it has one. */
export const tagEmbedText = (tag: string, description: string | null): string => {
  const words = tag.replace(/-+/g, ' ');
  const about = description?.trim() ?? '';
  return about.length > 0 ? `${words}: ${about}` : words;
};

const DEFAULT_BATCH_SIZE = 32;

const inFlight = new WeakMap<DatabaseSync, Promise<TagEmbedSummary>>();

/**
 * Embed every taxonomy tag whose text changed since its vector was written,
 * one pass per database at a time; a second caller awaits the running pass.
 * A vector that comes back non-finite is not stored, so the tag is pending
 * again next time.
 */
export const embedTagsPending = (
  db: DatabaseSync,
  embedder: Embedder,
  opts: {batchSize?: number} = {}
): Promise<TagEmbedSummary> => {
  let pass = inFlight.get(db);
  if (!pass) {
    pass = run(db, embedder, opts.batchSize ?? DEFAULT_BATCH_SIZE).finally(() => {
      inFlight.delete(db);
    });
    inFlight.set(db, pass);
  }
  return pass;
};

const run = async (
  db: DatabaseSync,
  embedder: Embedder,
  batchSize: number
): Promise<TagEmbedSummary> => {
  const started = Date.now();
  const repo = new TagVecRepository(db);
  const rows = db
    .prepare('SELECT tag, description FROM tags_taxonomy ORDER BY tag')
    .all() as unknown[] as {tag: string; description: string | null}[];
  const stored = repo.hashes();
  const pending: {tag: string; text: string; hash: string}[] = [];
  for (const row of rows) {
    const text = tagEmbedText(row.tag, row.description);
    const hash = contentHash(text);
    if (stored.get(row.tag) !== hash) pending.push({tag: row.tag, text, hash});
  }
  const current = db.prepare('SELECT description FROM tags_taxonomy WHERE tag = ?');
  let embedded = 0;
  for (let i = 0; i < pending.length; i += batchSize) {
    const batch = pending.slice(i, i + batchSize);
    const vecs = await embedder.embedBatch(batch.map(p => p.text));
    for (let j = 0; j < batch.length; ++j) {
      const vec = vecs[j];
      const item = batch[j]!;
      if (!vec || !vec.every(Number.isFinite)) continue;
      // Deleted or re-described during the await: its delete trigger has run,
      // or its text moved on (D114).
      const row = current.get(item.tag) as {description: string | null} | undefined;
      if (!row || contentHash(tagEmbedText(item.tag, row.description)) !== item.hash) continue;
      repo.set(item.tag, item.hash, vec);
      ++embedded;
    }
  }
  return {
    embedded,
    upToDate: rows.length - pending.length,
    total: rows.length,
    durationMs: Date.now() - started
  };
};
