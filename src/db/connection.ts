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
    // The standard WAL pairing: fsync on checkpoint, not on every commit.
    // Crash-safe for the WAL itself; and this DB is a derived artifact
    // (rebuilt from the markdown tree by a reindex), so the durability
    // trade costs nothing while making bursty import commits cheaper.
    db.exec('PRAGMA synchronous = NORMAL');
  }

  return db;
};
