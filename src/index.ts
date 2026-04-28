// Entry point. Subcommands:
//   node src/index.ts info                  # report DB version + extension info
//   node src/index.ts import <vault-path>   # import a vault directory
import {resolve} from 'node:path';
import {openDatabase} from './db/connection.ts';
import {runMigrations} from './db/migrate.ts';
import {BgeEmbedder} from './embeddings/bge.ts';
import {embedPending} from './embeddings/embed-pass.ts';
import {FakeEmbedder} from './embeddings/fake.ts';
import type {Embedder} from './embeddings/types.ts';
import {importVault} from './importer/import.ts';

const dbPath = process.env['VAULT_DB_PATH'] ?? ':memory:';
const argv = process.argv.slice(2);
const subcommand = argv[0] ?? 'info';

const die = (msg: string, code = 1): never => {
  process.stderr.write(`vault-storage: ${msg}\n`);
  process.exit(code);
};

// VAULT_EMBEDDER=fake skips the BGE model load — useful for fast iteration on
// the importer/edge code without paying the model-load cost on every run. Tests
// always use FakeEmbedder by direct import; this env var is for the CLI only.
const makeEmbedder = (): Embedder =>
  process.env['VAULT_EMBEDDER'] === 'fake' ? new FakeEmbedder() : new BgeEmbedder();

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
    process.stdout.write(
      `edges: ${summary.edges.edgesCreated} created, ` +
        `${summary.edges.unresolvedFrontmatter} unresolved related:, ` +
        `${summary.edges.unresolvedBody} unresolved body wikilinks, ` +
        `${summary.edges.selfReferences} self-references skipped ` +
        `(${summary.edges.durationMs} ms)\n`
    );
    const embedder = makeEmbedder();
    const embed = await embedPending(db, embedder);
    process.stdout.write(
      `embed: ${embed.embedded} embedded, ${embed.upToDate} up-to-date ` +
        `(${embed.total} total, model=${embedder.modelName}, ${embed.durationMs} ms)\n`
    );
    break;
  }
  default:
    die(`unknown subcommand: ${subcommand}`);
}

db.close();
