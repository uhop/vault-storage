// Entry point — placeholder until the Koa server lands.
// Run with: node src/index.ts
import {openDatabase} from './db/connection.ts';
import {runMigrations} from './db/migrate.ts';

const dbPath = process.env['VAULT_DB_PATH'] ?? ':memory:';
const db = openDatabase({path: dbPath});

const result = runMigrations(db);
const vecVersion = (db.prepare('SELECT vec_version() AS v').get() as {v: string}).v;

process.stdout.write(
  `vault-storage: db=${dbPath} schema=${result.current} vec=${vecVersion} ` +
    `applied=[${result.applied.join(', ')}]\n`
);

db.close();
