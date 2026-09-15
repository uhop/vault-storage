import {startHealthMonitor} from './health.ts';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {openDatabase} from '../db/connection.ts';
import {runMigrations} from '../db/migrate.ts';
import {embedAllPending} from '../embeddings/embed-pass.ts';
import {FakeEmbedder} from '../embeddings/fake.ts';
import type {Embedder} from '../embeddings/types.ts';
import {ChildProcessEmbedder} from '../embeddings/child-embedder.ts';
import {startupReindex} from '../maintenance/startup-reindex.ts';
import {backfillChunkTextHashes} from '../maintenance/backfill-chunk-text-hashes.ts';
import {backfillDocVecs} from '../maintenance/backfill-doc-vecs.ts';
import {readServerEnv} from './env.ts';
import {startScanScheduler, type ScanSchedulerHandle} from '../maintenance/scan-scheduler.ts';
import {startGitSync, type GitSyncHandle} from './git-sync.ts';
import {processRss, startMemoryReporter, type MemoryReporterHandle} from './memory-reporter.ts';
import {ResolverCache} from './resolver-cache.ts';
import {startServer} from './server.ts';
import {startWatcher, type WatcherHandle} from './watcher.ts';

export const main = async (): Promise<void> => {
  const env = readServerEnv();
  mkdirSync(dirname(env.vaultDbPath), {recursive: true});

  const db = openDatabase({path: env.vaultDbPath});
  const migration = runMigrations(db);

  const childEmbedder =
    env.embedder === 'fake'
      ? null
      : new ChildProcessEmbedder({
          kind: 'bge',
          anomalyLogPath: env.embedAnomalyLogPath,
          retentionMs: env.embedderRetentionMs,
          maxBatch: env.embedderMaxBatch
        });
  const embedder: Embedder = childEmbedder ?? new FakeEmbedder();

  // Shared between the HTTP layer (/resolve reads it; write handlers
  // invalidate) and the watcher (drains invalidate after disk changes).
  const resolverCache = new ResolverCache(db);

  // In-memory health: git-sync and the watcher report into it, /system/health reads it.
  const health = startHealthMonitor();
  // Listen before the initial reindex: the database persisted, so requests are
  // answered from the last indexed state while the reindex catches up.
  const handle = await startServer({
    db,
    env,
    schemaVersion: migration.current,
    embedder,
    resolverCache,
    health
  });
  process.stdout.write(
    `vault-storage: listening on ${handle.url} ` +
      `(db=${env.vaultDbPath} schema=${migration.current} vault=${env.vaultDataPath})\n`
  );

  // Watch from the moment requests are served: a write landing during the
  // reindex is imported by its handler, and only a watcher drain embeds it.
  let watcher: WatcherHandle | null = null;
  if (env.autoWatch) {
    watcher = startWatcher({
      db,
      vaultDataPath: env.vaultDataPath,
      embedder,
      debounceMs: env.watchDebounceMs,
      onIndexChanged: () => resolverCache.invalidate(),
      health
    });
    process.stdout.write(
      `vault-storage: watching ${env.vaultDataPath} (debounce=${env.watchDebounceMs}ms)\n`
    );
  }

  // Before git-sync: git-sync commits dirty files and advances the anchor,
  // which would hide them from the working-tree pass.
  if (env.autoReindex) {
    process.stdout.write(`vault-storage: initial reindex of ${env.vaultDataPath}…\n`);
    try {
      const summary = await startupReindex(db, env.vaultDataPath, {
        reindexMigrations: migration.reindex
      });
      resolverCache.invalidate();
      health.recordReindex({ok: true});
      process.stdout.write(
        `vault-storage: reindex done — ${summary.reason ? `full (${summary.reason})` : 'incremental'}, ` +
          `${summary.changedFiles} files, ${summary.imported} imported, ${summary.deleted} deleted, ` +
          `${summary.renamed} renamed (${summary.durationMs} ms)\n`
      );
    } catch (err) {
      health.recordReindex({ok: false, error: err instanceof Error ? err.message : String(err)});
      throw err;
    }
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
  const textHashes = await backfillChunkTextHashes(db);
  if (textHashes.candidates > 0) {
    process.stdout.write(
      `vault-storage: chunk text-hash backfill — ${textHashes.written} written, ` +
        `${textHashes.skipped} skipped (${textHashes.durationMs} ms)\n`
    );
  }

  let memoryReporter: MemoryReporterHandle | null = null;
  if (env.memoryReportIntervalMs > 0) {
    memoryReporter = startMemoryReporter({
      intervalMs: env.memoryReportIntervalMs,
      embedderRss: async () => {
        const pid = childEmbedder?.pid ?? null;
        return pid === null ? null : processRss(pid);
      }
    });
  }

  const workHours =
    env.workHoursStart !== null && env.workHoursEnd !== null
      ? {start: env.workHoursStart, end: env.workHoursEnd}
      : undefined;

  let gitSync: GitSyncHandle | null = null;
  if (env.autoCommit) {
    gitSync = startGitSync({
      vaultDataPath: env.vaultDataPath,
      intervalMs: env.commitIntervalMs,
      intervalMaxMs: env.commitIntervalMaxMs,
      workHours,
      autoPush: env.autoPush,
      authorName: env.gitAuthorName,
      authorEmail: env.gitAuthorEmail,
      db,
      health
    });
    const backoff =
      env.commitIntervalMaxMs > env.commitIntervalMs
        ? `${env.commitIntervalMs}–${env.commitIntervalMaxMs}ms backoff`
        : `${env.commitIntervalMs}ms`;
    const window = workHours ? ` work-hours=${workHours.start}–${workHours.end}` : '';
    process.stdout.write(`vault-storage: git-sync ${backoff} (push=${env.autoPush})${window}\n`);
  }

  // Last and not awaited: a backlog (every note, after a chunker change) takes
  // hours on croc, and nothing above may wait for it. Rounds let watcher drains
  // embed their edits in between.
  if (env.autoReindex) {
    embedAllPending(db, embedder).then(
      embed =>
        process.stdout.write(
          `vault-storage: startup embed done — ${embed.embedded} embedded, ` +
            `${embed.chunksReused} chunks reused (${embed.durationMs} ms)\n`
        ),
      err => {
        health.recordReindex({ok: false, error: err instanceof Error ? err.message : String(err)});
        process.stderr.write(`vault-storage: startup embed failed: ${String(err)}\n`);
      }
    );
  }

  let scanScheduler: ScanSchedulerHandle | null = null;
  if (env.scanEnabled ?? true) {
    const intervalMs = env.scanIntervalMs ?? 3_600_000;
    const maxQuietMs = env.scanMaxQuietMs ?? 7 * 86_400_000;
    scanScheduler = startScanScheduler({db, intervalMs, maxQuietMs, workHours});
    const window = workHours ? ` work-hours=${workHours.start}–${workHours.end}` : '';
    process.stdout.write(
      `vault-storage: scan-scheduler every ${intervalMs}ms, changed-since-last-pass skip, max-quiet ${maxQuietMs}ms${window}\n`
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
    if (scanScheduler) scanScheduler.close();
    health.close();
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
