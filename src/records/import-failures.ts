// A file whose import threw (schema 0038, D113): without a row the file is
// missing from every index, or stale in all of them, and nothing says so.

import type {DatabaseSync, StatementSync} from 'node:sqlite';
import {prepared} from '../db/prepared.ts';

export interface ImportFailureRow {
  filePath: string;
  /** The record the file had before it failed; null when it was never indexed. */
  recordId: string | null;
  message: string;
  seenAt: string;
}

/**
 * The first line of a thrown value, which is where the parsers put the cause;
 * `yaml` ends it with a colon that introduced the context lines below.
 */
export const failureMessage = (err: unknown): string =>
  ((err instanceof Error ? err.message : String(err)).split('\n')[0] as string).replace(/:$/, '');

export class ImportFailuresRepository {
  readonly #db: DatabaseSync;
  readonly #clear: StatementSync;
  readonly #record: StatementSync;

  // Only the per-import statements are prepared here: this repository is built
  // with every `fullImportOptions` call, which is per request (4b).
  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#clear = prepared(db, 'DELETE FROM import_failures WHERE file_path = ?');
    this.#record = prepared(
      db,
      `INSERT INTO import_failures (file_path, message, seen_at) VALUES (?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET message = excluded.message, seen_at = excluded.seen_at`
    );
  }

  record(filePath: string, err: unknown, now: string): void {
    this.#record.run(filePath, failureMessage(err), now);
  }

  clear(filePath: string): void {
    this.#clear.run(filePath);
  }

  clearAll(): void {
    this.#db.exec('DELETE FROM import_failures');
  }

  count(): number {
    return (prepared(this.#db, 'SELECT COUNT(*) AS n FROM import_failures').get() as {n: number}).n;
  }

  list(limit: number): ImportFailureRow[] {
    const rows = prepared(
      this.#db,
      `SELECT f.file_path, r.record_id, f.message, f.seen_at
           FROM import_failures f LEFT JOIN records r ON r.file_path = f.file_path
          ORDER BY f.file_path LIMIT ?`
    ).all(limit) as unknown[] as {
      file_path: string;
      record_id: string | null;
      message: string;
      seen_at: string;
    }[];
    return rows.map(r => ({
      filePath: r.file_path,
      recordId: r.record_id,
      message: r.message,
      seenAt: r.seen_at
    }));
  }
}
