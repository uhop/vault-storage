// Who wrote each uncommitted path (D136). A request runs inside writeContext with
// its session and database, so any write site records its paths with one call,
// and the commit pass commits each writer's paths under that writer's name. The
// API token's writes keep the configured author, as every write did before.

import {AsyncLocalStorage} from 'node:async_hooks';
import type {DatabaseSync} from 'node:sqlite';
import {prepared} from '../db/prepared.ts';
import {LEGACY_KEY_ID, type Session} from './keys.ts';

export interface Writer {
  key_id: string;
  name: string;
  kind: string;
  email: string | null;
}

export const writeContext = new AsyncLocalStorage<{session: Session; db: DatabaseSync}>();

/** The paths this request writes, moves, or removes, vault-relative; the last named writer wins. */
export const recordWriter = (paths: readonly string[]): void => {
  const store = writeContext.getStore();
  if (!store) return;
  const {session, db} = store;
  if (session.key_id === LEGACY_KEY_ID) {
    const drop = prepared(db, 'DELETE FROM pending_writers WHERE path = ?');
    for (const path of paths) drop.run(path);
    return;
  }
  const upsert = prepared(
    db,
    `INSERT INTO pending_writers (path, key_id, name, kind, email, written_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET key_id = excluded.key_id, name = excluded.name,
       kind = excluded.kind, email = excluded.email, written_at = excluded.written_at`
  );
  const now = new Date().toISOString();
  for (const path of paths)
    upsert.run(path, session.key_id, session.name, session.kind, session.email, now);
};

/** The recorded writer of each path that has one. */
export const writersOf = (db: DatabaseSync, paths: readonly string[]): Map<string, Writer> => {
  const get = prepared(db, 'SELECT key_id, name, kind, email FROM pending_writers WHERE path = ?');
  const out = new Map<string, Writer>();
  for (const path of paths) {
    const row = get.get(path) as Writer | undefined;
    if (row) out.set(path, {...row});
  }
  return out;
};

/** Forget the writers recorded before `before`; a write after it is for the next commit. */
export const clearWriters = (db: DatabaseSync, paths: readonly string[], before: string): void => {
  const drop = prepared(db, 'DELETE FROM pending_writers WHERE path = ? AND written_at < ?');
  for (const path of paths) drop.run(path, before);
};

/** Rows for paths that are no longer dirty: nothing left to attribute. */
export const dropStaleWriters = (
  db: DatabaseSync,
  dirty: ReadonlySet<string>,
  before: string
): void => {
  const rows = prepared(db, 'SELECT path FROM pending_writers WHERE written_at < ?').all(
    before
  ) as unknown[] as {path: string}[];
  const drop = prepared(db, 'DELETE FROM pending_writers WHERE path = ?');
  for (const {path} of rows) if (!dirty.has(path)) drop.run(path);
};
