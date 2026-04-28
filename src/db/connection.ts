import {DatabaseSync} from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';

export interface OpenOptions {
  /** ':memory:' for ephemeral, or a filesystem path. */
  path: string;
  readOnly?: boolean;
}

/**
 * Open a SQLite database with the sqlite-vec extension loaded and sane pragmas.
 * Callers own the returned handle and must call .close() when done.
 */
export const openDatabase = (opts: OpenOptions): DatabaseSync => {
  const db = new DatabaseSync(opts.path, {
    readOnly: opts.readOnly ?? false,
    allowExtension: true
  });

  sqliteVec.load(db);

  db.exec('PRAGMA foreign_keys = ON');
  if (!opts.readOnly && opts.path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }

  return db;
};
