import {chunkMatrixStatus} from '../../db/chunk-matrix.ts';
import type {HealthMonitor} from '../health.ts';
import type {DatabaseSync} from 'node:sqlite';
import type {Embedder} from '../../embeddings/types.ts';
import {revertExpiredClaims} from '../../records/claims.ts';
import {NO_QUERY_PARAMS, rejectUnknownParams} from '../query.ts';
import {sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

export interface SystemDeps {
  db: DatabaseSync;
  schemaVersion: number;
  vaultDataPath: string;
  embedder: Embedder;
}

export const systemStatusHandler =
  (deps: SystemDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const {db, schemaVersion, vaultDataPath, embedder} = deps;
    const vecVersion = (db.prepare('SELECT vec_version() AS v').get() as {v: string}).v;
    const recordCount = (db.prepare('SELECT COUNT(*) AS n FROM records').get() as {n: number}).n;
    const edgeCount = (db.prepare('SELECT COUNT(*) AS n FROM edges').get() as {n: number}).n;
    revertExpiredClaims(db);
    const pendingSuggestions = (
      db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE status = 'pending'`).get() as {
        n: number;
      }
    ).n;
    const lastIndexedRow = db
      .prepare(`SELECT value FROM meta WHERE key = 'last_indexed_commit'`)
      .get() as {value: string} | undefined;

    const m = process.memoryUsage();

    sendJson(ctx.res, 200, {
      ok: true,
      schema_version: schemaVersion,
      sqlite_vec_version: vecVersion,
      vault_data_path: vaultDataPath,
      records: recordCount,
      edges: edgeCount,
      pending_suggestions: pendingSuggestions,
      last_indexed_commit: lastIndexedRow ? lastIndexedRow.value : null,
      indexer_running: false,
      embedder: {
        model: embedder.modelName,
        retained: embedder.retained
      },
      chunk_matrix: chunkMatrixStatus(db),
      memory: {
        rss: m.rss,
        heap_used: m.heapUsed,
        heap_total: m.heapTotal,
        external: m.external,
        array_buffers: m.arrayBuffers
      }
    });
  };

export interface ReleaseEmbedderDeps {
  embedder: Embedder;
}

/**
 * POST /maintenance/release-embedder
 *
 * Force-release the embedder's retained native resources (ONNX session arena
 * for the BGE pipeline). Captures `process.memoryUsage()` before and after
 * so the caller can see the actual RSS drop without waiting for the idle
 * retention timer. No-op (returns `{retained_before: false, ...}`) when the
 * embedder isn't currently holding anything.
 */
export const releaseEmbedderHandler =
  (deps: ReleaseEmbedderDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const retainedBefore = deps.embedder.retained;
    const memBefore = process.memoryUsage();
    const start = performance.now();
    await deps.embedder.releaseRetained();
    const durationMs = Math.round(performance.now() - start);
    const memAfter = process.memoryUsage();
    sendJson(ctx.res, 200, {
      retained_before: retainedBefore,
      retained_after: deps.embedder.retained,
      duration_ms: durationMs,
      rss_before: memBefore.rss,
      rss_after: memAfter.rss,
      rss_freed: memBefore.rss - memAfter.rss
    });
  };

const warming = new WeakMap<Embedder, Promise<void>>();

/**
 * POST /maintenance/warm-embedder
 *
 * Start loading the embedding model in the background, so the first semantic
 * search after an idle release does not wait for it (about 35 s on croc).
 * Callers are the SessionStart hook and the UI's search box, before any
 * query. Retention is unchanged: the model is released again after the idle
 * window. Returns 200 `{retained: true, started: false}` when it is loaded,
 * else 202 `{retained: false, started}`, `started` false when a load one of
 * these calls began is still running.
 */
export const warmEmbedderHandler =
  (deps: ReleaseEmbedderDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const {embedder} = deps;
    if (embedder.retained) {
      sendJson(ctx.res, 200, {retained: true, started: false});
      return;
    }
    const started = !warming.has(embedder);
    if (started) {
      warming.set(
        embedder,
        embedder
          .embedQuery('warm')
          .then(
            () => undefined,
            () => undefined
          )
          .finally(() => warming.delete(embedder))
      );
    }
    sendJson(ctx.res, 202, {retained: false, started});
  };

/**
 * GET /system/health — what the process knows about itself from memory
 * alone: uptime, the watchdog's lag, the last git-sync and reindex outcomes,
 * the watcher's last event, and `stalled`. Touches neither the database nor
 * the data mount, so it still answers while storage is wedged and the loop
 * is not; `/system/status` is the probe that fails with storage. Always
 * 200 — the read succeeded; the verdict is in the body (`ok`).
 */
export const healthHandler =
  (monitor: HealthMonitor): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    sendJson(ctx.res, 200, monitor.snapshot());
  };
