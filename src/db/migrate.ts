import type {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'schema');
const MIGRATION_FILE = /^(\d{4})_.*\.sql$/;

export interface MigrationResult {
  /** Filenames of migrations applied in this call (already-applied ones are skipped). */
  applied: string[];
  /** Schema version after the run. */
  current: number;
}

/**
 * Apply any pending migrations from src/db/schema/<NNNN>_*.sql in numeric order.
 * Each migration file is responsible for updating meta.schema_version as its last step.
 */
export const runMigrations = (db: DatabaseSync): MigrationResult => {
  db.exec(
    `CREATE TABLE IF NOT EXISTS meta (
       key   TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`
  );
  db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '0')`);

  const getVersion = (): number => {
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | {value: string}
      | undefined;
    return row ? Number.parseInt(row.value, 10) : 0;
  };

  const files = readdirSync(SCHEMA_DIR)
    .filter(name => MIGRATION_FILE.test(name))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const match = MIGRATION_FILE.exec(file);
    if (!match || !match[1]) continue;
    const version = Number.parseInt(match[1], 10);
    if (version <= getVersion()) continue;

    const sql = readFileSync(join(SCHEMA_DIR, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`, {cause: err});
    }
    applied.push(file);
  }

  return {applied, current: getVersion()};
};
