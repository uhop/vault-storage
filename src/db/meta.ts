// Typed helpers for the `meta` key-value table (created by the migration
// runner; also home to `schema_version` and `last_indexed_commit`).

import type {DatabaseSync} from 'node:sqlite';

export const getMetaValue = (db: DatabaseSync, key: string): string | null => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | {value: string}
    | undefined;
  return row?.value ?? null;
};

export const setMetaValue = (db: DatabaseSync, key: string, value: string): void => {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
};

/**
 * Monotonic counter bumped on every content-shaping records mutation —
 * upsert, delete, file-path move (see `RecordsRepository`). Deliberately
 * NOT bumped by reads (`last_referenced`), suggestion writes, or embedding
 * passes: those must not make the vault look "changed" to the C8.1 scan
 * scheduler, which compares this counter against the last completed
 * maintenance pass to decide whether scanning is worth it.
 */
export const CONTENT_GENERATION_KEY = 'content_generation';

export const getContentGeneration = (db: DatabaseSync): number => {
  const raw = getMetaValue(db, CONTENT_GENERATION_KEY);
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
};
