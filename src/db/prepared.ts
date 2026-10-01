import type {DatabaseSync, StatementSync} from 'node:sqlite';

/** Statements kept per database; past this many, the least recently used is dropped. */
export const PREPARED_CAPACITY = 1000;

const caches = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/**
 * The statement for `sql` on `db`, prepared on first use and kept (D124), for
 * SQL that repeats: a request's, a write's, a repository's. One-off text, such
 * as a scan's or a migration's, goes to `db.prepare`, so it does not crowd the
 * cache.
 */
export const prepared = (db: DatabaseSync, sql: string): StatementSync => {
  let cache = caches.get(db);
  if (!cache) caches.set(db, (cache = new Map()));
  let statement = cache.get(sql);
  if (statement) {
    cache.delete(sql);
  } else {
    statement = db.prepare(sql);
    if (cache.size >= PREPARED_CAPACITY) cache.delete(cache.keys().next().value as string);
  }
  cache.set(sql, statement);
  return statement;
};
