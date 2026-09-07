import type {DatabaseSync} from 'node:sqlite';
import {getContentGeneration} from '../db/meta.ts';
import {getLastIndexedCommit} from '../maintenance/incremental-reindex.ts';

/**
 * The content generation an answer was computed at, so a client can tell
 * "empty at generation N" from "empty", compare two reads, or hold a read
 * against a later write. `generation` moves on every content-shaping record
 * mutation (see `CONTENT_GENERATION_KEY`), `indexed_commit` is the vault-data
 * commit the index last caught up to, `at` is the server clock.
 */
export interface AsOf {
  generation: number;
  indexed_commit: string | null;
  at: string;
}

export const asOf = (db: DatabaseSync): AsOf => ({
  generation: getContentGeneration(db),
  indexed_commit: getLastIndexedCommit(db),
  at: new Date().toISOString()
});

/** The same stamp as headers, for responses whose body is not an object. */
export const asOfHeaders = (stamp: AsOf): Record<string, string> => ({
  'X-Vault-Generation': String(stamp.generation),
  'X-Vault-Indexed-Commit': stamp.indexed_commit ?? '',
  'X-Vault-As-Of': stamp.at
});
