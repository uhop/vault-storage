import type {DatabaseSync} from 'node:sqlite';
import type {Embedder} from '../../embeddings/types.ts';
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
    const {db, schemaVersion, vaultDataPath, embedder} = deps;
    const vecVersion = (db.prepare('SELECT vec_version() AS v').get() as {v: string}).v;
    const recordCount = (db.prepare('SELECT COUNT(*) AS n FROM records').get() as {n: number}).n;
    const edgeCount = (db.prepare('SELECT COUNT(*) AS n FROM edges').get() as {n: number}).n;
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
