import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {openDatabase} from '../db/connection.ts';
import {runMigrations} from '../db/migrate.ts';
import {JsonlAnomalyLogger} from '../embeddings/anomaly-log.ts';
import {BgeEmbedder} from '../embeddings/bge.ts';
import {embedPending} from '../embeddings/embed-pass.ts';
import {FakeEmbedder} from '../embeddings/fake.ts';
import type {Embedder} from '../embeddings/types.ts';
import {importVault} from '../importer/import.ts';
import {setLastIndexedCommit} from '../maintenance/incremental-reindex.ts';
import {getCurrentHead} from '../util/git.ts';
import {backfillDocVecs} from '../maintenance/backfill-doc-vecs.ts';
import {readServerEnv} from './env.ts';
import {startGitSync, type GitSyncHandle} from './git-sync.ts';
import {startMemoryReporter, type MemoryReporterHandle} from './memory-reporter.ts';
import {ResolverCache} from './resolver-cache.ts';
import {startServer} from './server.ts';
import {startWatcher, type WatcherHandle} from './watcher.ts';

export const main = async (): Promise<void> => {
  const env = readServerEnv();
  mkdirSync(dirname(env.vaultDbPath), {recursive: true});

  const db = openDatabase({path: env.vaultDbPath});
  const migration = runMigrations(db);

  const anomalyLogger = env.embedAnomalyLogPath
    ? new JsonlAnomalyLogger(env.embedAnomalyLogPath)
    : null;
  const embedder: Embedder =
    env.embedder === 'fake'
      ? new FakeEmbedder()
      : new BgeEmbedder({
          anomalyLogger,
          retentionMs: env.embedderRetentionMs,
          maxBatch: env.embedderMaxBatch
        });

  if (env.autoReindex) {
    process.stdout.write(`vault-storage: initial reindex of ${env.vaultDataPath}…\n`);
    const summary = importVault(db, env.vaultDataPath);
    const embed = await embedPending(db, embedder);
    // Pin the multi-writer reindex anchor to the current HEAD so a
    // subsequent post-pull diff has a clean range.
    const head = await getCurrentHead(env.vaultDataPath);
    if (head) setLastIndexedCommit(db, head);
    process.stdout.write(
      `vault-storage: reindex done — ${summary.inserted} new, ${summary.updated} updated, ` +
        `${summary.unchanged} unchanged, ${summary.skipped} skipped, ` +
        `${summary.edges.edgesCreated} edges, ${embed.embedded} embedded ` +
        `(${summary.durationMs}+${embed.durationMs} ms)\n`
    );
  }

  // Bring `record_doc_vec` up to current. Idempotent: skips records whose
  // doc-vec content_hash already matches their chunks. Backfills retroactively
  // for records embedded before doc-vec storage existed (schema 4 onwards).
  const backfill = backfillDocVecs(db);
  if (backfill.written > 0 || backfill.skipped > 0) {
    process.stdout.write(
      `vault-storage: doc-vec backfill — ${backfill.written} written, ` +
        `${backfill.upToDate} up-to-date, ${backfill.skipped} skipped ` +
        `(${backfill.durationMs} ms)\n`
    );
  }

  // Shared between the HTTP layer (/resolve reads it; write handlers
  // invalidate) and the watcher (drains invalidate after disk changes).
  const resolverCache = new ResolverCache(db);

  const handle = await startServer({
    db,
    env,
    schemaVersion: migration.current,
    embedder,
    resolverCache
  });
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
      debounceMs: env.watchDebounceMs,
      onIndexChanged: () => resolverCache.invalidate()
    });
    process.stdout.write(
      `vault-storage: watching ${env.vaultDataPath} (debounce=${env.watchDebounceMs}ms)\n`
    );
  }

  let memoryReporter: MemoryReporterHandle | null = null;
  if (env.memoryReportIntervalMs > 0) {
    memoryReporter = startMemoryReporter({intervalMs: env.memoryReportIntervalMs});
  }

  let gitSync: GitSyncHandle | null = null;
  if (env.autoCommit) {
    const workHours =
      env.workHoursStart !== null && env.workHoursEnd !== null
        ? {start: env.workHoursStart, end: env.workHoursEnd}
        : undefined;
    gitSync = startGitSync({
      vaultDataPath: env.vaultDataPath,
      intervalMs: env.commitIntervalMs,
      intervalMaxMs: env.commitIntervalMaxMs,
      workHours,
      autoPush: env.autoPush,
      authorName: env.gitAuthorName,
      authorEmail: env.gitAuthorEmail,
      db
    });
    const backoff =
      env.commitIntervalMaxMs > env.commitIntervalMs
        ? `${env.commitIntervalMs}–${env.commitIntervalMaxMs}ms backoff`
        : `${env.commitIntervalMs}ms`;
    const window = workHours ? ` work-hours=${workHours.start}–${workHours.end}` : '';
    process.stdout.write(`vault-storage: git-sync ${backoff} (push=${env.autoPush})${window}\n`);
  }

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(`\nvault-storage: ${signal} received, shutting down\n`);
    if (watcher) {
      // Drain any pending changes before exit so we don't lose updates that
      // arrived during the debounce window.
      await watcher.flush();
      watcher.close();
    }
    if (gitSync) {
      await gitSync.syncNow();
      gitSync.close();
    }
    if (memoryReporter) memoryReporter.close();
    await handle.close();
    await embedder.releaseRetained();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};
