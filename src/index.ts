// Entry point. Subcommands:
//   node src/index.ts info                       # report DB version + extension info
//   node src/index.ts import [vault-path]        # import a vault dir (path or $VAULT_INGEST_PATH)
//   node src/index.ts migrate <source> <target>  # migrate Obsidian vault → vault-data tree
//   node src/index.ts serve                      # start the REST server
import {resolve} from 'node:path';
import {openDatabase} from './db/connection.ts';
import {runMigrations} from './db/migrate.ts';
import {JsonlAnomalyLogger} from './embeddings/anomaly-log.ts';
import {BgeEmbedder} from './embeddings/bge.ts';
import {embedPending} from './embeddings/embed-pass.ts';
import {FakeEmbedder} from './embeddings/fake.ts';
import type {Embedder} from './embeddings/types.ts';
import {importVault} from './importer/import.ts';
import {migrateVault} from './migration/import.ts';
import {syncFromObsidian} from './migration/sync.ts';
import {main as serveMain} from './server/index.ts';

const argv = process.argv.slice(2);
const subcommand = argv[0] ?? 'info';

const die = (msg: string, code = 1): never => {
  process.stderr.write(`vault-storage: ${msg}\n`);
  process.exit(code);
};

// VAULT_EMBEDDER=fake skips the BGE model load — useful for fast iteration on
// the importer/edge code without paying the model-load cost on every run. Tests
// always use FakeEmbedder by direct import; this env var is for the CLI only.
//
// VAULT_EMBED_ANOMALY_LOG=<path> persists transient-NaN events as JSONL.
// Off by default in CLI mode (stderr-only); the server bootstrap defaults
// it to `${VAULT_DATA_PATH}/.vault-storage/embed-nan.jsonl`.
const makeEmbedder = (): Embedder => {
  if (process.env['VAULT_EMBEDDER'] === 'fake') return new FakeEmbedder();
  const logPath = process.env['VAULT_EMBED_ANOMALY_LOG'];
  const anomalyLogger = logPath ? new JsonlAnomalyLogger(logPath) : null;
  return new BgeEmbedder({anomalyLogger});
};

if (subcommand === 'serve') {
  // The server has its own env handling and lifetime — it owns its DB handle.
  await serveMain();
} else {
  const dbPath = process.env['VAULT_DB_PATH'] ?? ':memory:';
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
    case 'migrate': {
      const updateFlagIndex = argv.indexOf('--update');
      const dryRun = argv.includes('--dry-run');

      if (updateFlagIndex >= 0) {
        const positional = argv.filter((v, i) => i > 0 && v !== '--update' && v !== '--dry-run');
        const source = positional[0] ?? process.env['OBSIDIAN_VAULT_PATH'];
        const target = positional[1] ?? process.env['VAULT_DATA_PATH'];
        if (!source)
          die('usage: migrate --update <obsidian-source> [target]  (or set OBSIDIAN_VAULT_PATH)');
        if (!target)
          die('usage: migrate --update <obsidian-source> <target>  (or set VAULT_DATA_PATH)');
        const summary = syncFromObsidian({
          source: resolve(source as string),
          target: resolve(target as string),
          db,
          dryRun,
          writeLog: !dryRun
        });
        process.stdout.write(
          `sync from ${source}: ` +
            `${summary.new} new, ${summary.updated} updated, ${summary.unchanged} unchanged, ` +
            `${summary.skippedLocallyNewer} skipped (local edit), ` +
            `${summary.skippedAtomized} skipped (atomized), ` +
            `${summary.removedInSource} removed in source ` +
            `(${summary.total} source files, ${summary.durationMs} ms)` +
            (dryRun ? ' [dry-run]' : '') +
            '\n'
        );
        if (summary.logPath) process.stdout.write(`log: ${summary.logPath}\n`);
        break;
      }

      const source = argv[1] ?? process.env['VAULT_INGEST_PATH'];
      const target = argv[2] ?? process.env['VAULT_DATA_PATH'];
      if (!source) die('usage: migrate <source> <target>  (or set VAULT_INGEST_PATH)');
      if (!target) die('usage: migrate <source> <target>  (or set VAULT_DATA_PATH)');
      const summary = migrateVault({
        source: resolve(source as string),
        target: resolve(target as string),
        db
      });
      process.stdout.write(
        `migrated ${summary.total} files: ` +
          `${summary.backfilled} backfilled frontmatter, ` +
          `${summary.filesWithTagRewrites} files had tag rewrites ` +
          `(${summary.tagRewrites} total), ` +
          `${summary.canonicalTagCount} canonical tags, ` +
          `${summary.pluralCollapses.length} plural collapses ` +
          `(${summary.durationMs} ms)\n`
      );
      if (summary.pluralCollapses.length > 0) {
        process.stdout.write('plural collapses:\n');
        for (const c of summary.pluralCollapses) {
          process.stdout.write(`  ${c.plural} → ${c.singular}\n`);
        }
      }
      if (summary.atomization) {
        const a = summary.atomization;
        process.stdout.write(
          `atomization: ${a.atomized} files split into ${a.piecesWritten} pieces ` +
            `(${a.optedOut} opted out, ${a.total} considered, ${a.durationMs} ms)\n`
        );
      }
      break;
    }
    case 'import': {
      const vaultRoot = argv[1] ?? process.env['VAULT_INGEST_PATH'];
      if (!vaultRoot) die('usage: import <vault-path>  (or set VAULT_INGEST_PATH)');
      const summary = importVault(db, resolve(vaultRoot as string));
      process.stdout.write(
        `imported ${summary.total} files: ${summary.inserted} inserted, ` +
          `${summary.updated} updated, ${summary.unchanged} unchanged, ` +
          `${summary.skipped} skipped (${summary.durationMs} ms)\n`
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
      // Dispose the BGE pipeline so the retainer's pending retention timer
      // doesn't keep the event loop alive after the CLI completes.
      await embedder.releaseRetained();
      break;
    }
    default:
      die(`unknown subcommand: ${subcommand}`);
  }

  db.close();
}
