import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {openDatabase} from '../db/connection.ts';
import {runMigrations} from '../db/migrate.ts';
import {BgeEmbedder} from '../embeddings/bge.ts';
import {embedPending} from '../embeddings/embed-pass.ts';
import {FakeEmbedder} from '../embeddings/fake.ts';
import type {Embedder} from '../embeddings/types.ts';
import {importVault} from '../importer/import.ts';
import {readServerEnv} from './env.ts';
import {startServer} from './server.ts';
import {startWatcher, type WatcherHandle} from './watcher.ts';

export const main = async (): Promise<void> => {
  const env = readServerEnv();
  mkdirSync(dirname(env.vaultDbPath), {recursive: true});

  const db = openDatabase({path: env.vaultDbPath});
  const migration = runMigrations(db);

  const embedder: Embedder = env.embedder === 'fake' ? new FakeEmbedder() : new BgeEmbedder();

  if (env.autoReindex) {
    process.stdout.write(`vault-storage: initial reindex of ${env.vaultDataPath}…\n`);
    const summary = importVault(db, env.vaultDataPath);
    const embed = await embedPending(db, embedder);
    process.stdout.write(
      `vault-storage: reindex done — ${summary.inserted} new, ${summary.updated} updated, ` +
        `${summary.unchanged} unchanged, ${summary.skipped} skipped, ` +
        `${summary.edges.edgesCreated} edges, ${embed.embedded} embedded ` +
        `(${summary.durationMs}+${embed.durationMs} ms)\n`
    );
  }

  const handle = await startServer({db, env, schemaVersion: migration.current});
  process.stdout.write(
    `vault-storage: listening on ${handle.url} ` +
      `(db=${env.vaultDbPath} schema=${migration.current} vault=${env.vaultDataPath})\n`
  );

  let watcher: WatcherHandle | null = null;
  if (env.autoWatch) {
    watcher = startWatcher({
      db,
      vaultDataPath: env.vaultDataPath,
      embedder,
      debounceMs: env.watchDebounceMs
    });
    process.stdout.write(
      `vault-storage: watching ${env.vaultDataPath} (debounce=${env.watchDebounceMs}ms)\n`
    );
  }

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\nvault-storage: ${signal} received, shutting down\n`);
    if (watcher) {
      // Drain any pending changes before exit so we don't lose updates that
      // arrived during the debounce window.
      await watcher.flush();
      watcher.close();
    }
    await handle.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};
