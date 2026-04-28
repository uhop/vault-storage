// Entry point. Subcommands:
//   node src/index.ts info                  # report DB version + extension info
//   node src/index.ts import <vault-path>   # import a vault directory
import {resolve} from 'node:path';
import {openDatabase} from './db/connection.ts';
import {runMigrations} from './db/migrate.ts';
import {importVault} from './importer/import.ts';

const dbPath = process.env['VAULT_DB_PATH'] ?? ':memory:';
const argv = process.argv.slice(2);
const subcommand = argv[0] ?? 'info';

const die = (msg: string, code = 1): never => {
  process.stderr.write(`vault-storage: ${msg}\n`);
  process.exit(code);
};

const db = openDatabase({path: dbPath});
const migration = runMigrations(db);

switch (subcommand) {
  case 'info': {
    const vecVersion = (db.prepare('SELECT vec_version() AS v').get() as {v: string}).v;
    const recordCount = (db.prepare('SELECT COUNT(*) AS n FROM records').get() as {n: number}).n;
    process.stdout.write(
      `vault-storage: db=${dbPath} schema=${migration.current} vec=${vecVersion} ` +
        `records=${recordCount} applied=[${migration.applied.join(', ')}]\n`
    );
    break;
  }
  case 'import': {
    const vaultRoot = argv[1];
    if (!vaultRoot) die('usage: import <vault-path>');
    const summary = importVault(db, resolve(vaultRoot as string));
    process.stdout.write(
      `imported ${summary.total} files: ${summary.inserted} inserted, ` +
        `${summary.updated} updated, ${summary.unchanged} unchanged ` +
        `(${summary.durationMs} ms)\n`
    );
    break;
  }
  default:
    die(`unknown subcommand: ${subcommand}`);
}

db.close();
