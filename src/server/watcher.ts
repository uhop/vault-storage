// File-watcher → debounced incremental reindex. Keeps the DB in sync with
// VAULT_DATA_PATH while the server is running, so users can edit markdown in
// any tool and search/edges/embeddings stay current without manual `import`.
//
// Uses node:fs.watch with recursive:true. Events are coarse (no reliable
// create/modify/delete on Linux), so flush stats each path: present → import,
// missing → delete. Idempotent.

import {watch, statSync, type FSWatcher} from 'node:fs';
import {join, sep} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {embedPending} from '../embeddings/embed-pass.ts';
import type {Embedder} from '../embeddings/types.ts';
import {buildEdges} from '../importer/build-edges.ts';
import {SuggestionFiler} from '../importer/file-suggestions.ts';
import {importFile} from '../importer/import-file.ts';
import {TagsImporter} from '../importer/import-tags.ts';
import {QueueItemsRepository} from '../queue/repo.ts';
import {syncQueueFile} from '../queue/sync.ts';
import {RecordsRepository} from '../records/repository.ts';

export interface WatcherHandle {
  close: () => void;
  /** Drains the pending queue immediately (used by tests + on shutdown). */
  flush: () => Promise<FlushSummary>;
}

export interface FlushSummary {
  imported: number;
  deleted: number;
  errors: number;
  edgesCreated: number;
  embedded: number;
  /** queue_items rows inserted/updated/refreshed/deleted across all touched queue files. */
  queueItemsTouched: number;
}

export interface WatcherOptions {
  db: DatabaseSync;
  vaultDataPath: string;
  embedder: Embedder;
  /** Wait this long after the last event before flushing the batch. */
  debounceMs?: number;
  log?: (msg: string) => void;
  /** Errors during flush — exposed for tests. Default: write to stderr. */
  onError?: (err: unknown) => void;
  /**
   * Called after a drain that changed the index (any import / delete).
   * Composition wires this to ResolverCache.invalidate() so /resolve
   * never serves paths the drain just changed.
   */
  onIndexChanged?: () => void;
}

const SKIP_PATH_PARTS: ReadonlySet<string> = new Set([
  '.git',
  '.obsidian',
  'node_modules',
  '.vault-storage'
]);

const shouldIgnore = (relativePath: string): boolean => {
  if (!relativePath.endsWith('.md')) return true;
  for (const part of relativePath.split('/')) {
    if (SKIP_PATH_PARTS.has(part)) return true;
  }
  return false;
};

export const startWatcher = (opts: WatcherOptions): WatcherHandle => {
  const {db, vaultDataPath, embedder} = opts;
  const debounceMs = opts.debounceMs ?? 1500;
  const log = opts.log ?? (msg => process.stdout.write(`vault-storage: ${msg}\n`));
  const onError =
    opts.onError ??
    (err => process.stderr.write(`watcher: ${err instanceof Error ? err.message : String(err)}\n`));

  const records = new RecordsRepository(db);
  const tags = new TagsImporter(db);
  const agentStale = new SuggestionFiler(db, 'agent_enrichment_stale');
  const tagSuggestion = new SuggestionFiler(db, 'tag_suggestion');
  const archiveCandidate = new SuggestionFiler(db, 'archive_candidate');
  const queueItems = new QueueItemsRepository(db);

  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const drain = async (): Promise<FlushSummary> => {
    if (pending.size === 0)
      return {
        imported: 0,
        deleted: 0,
        errors: 0,
        edgesCreated: 0,
        embedded: 0,
        queueItemsTouched: 0
      };
    const batch = [...pending];
    pending.clear();

    const now = new Date().toISOString();
    let imported = 0;
    let deleted = 0;
    let errors = 0;
    let queueItemsTouched = 0;
    // Content-only batches rebuild edges for just the touched records. Any
    // path-set change (create / delete / rename-as-delete+create) falls back
    // to the full rebuild: wikilink resolution keys on file paths, so a new
    // or vanished path can flip basename-uniqueness / folder-fallback
    // resolution for records far outside the batch.
    let pathSetChanged = false;
    const changedRecordIds = new Set<string>();

    db.exec('BEGIN');
    try {
      for (const relativePath of batch) {
        try {
          const abs = join(vaultDataPath, relativePath);
          let exists = true;
          try {
            statSync(abs);
          } catch {
            exists = false;
          }
          if (!exists) {
            const existing = records.getByPath(relativePath);
            if (existing) {
              records.delete(existing.recordId);
              deleted++;
              pathSetChanged = true;
            }
            // Queue files removed from disk: drop the slice too. No-op for
            // any non-queue path.
            const dropped = syncQueueFile(queueItems, relativePath, vaultDataPath, now);
            if (dropped) queueItemsTouched += dropped.deleted;
            continue;
          }
          const importResult = importFile(records, relativePath, abs, now, {
            tags,
            agentStale,
            tagSuggestion,
            archiveCandidate
          });
          if (importResult.action === 'inserted') {
            pathSetChanged = true;
          } else {
            // 'updated' AND 'unchanged' both rebuild edges: an FM-only edit
            // (related: / edges: maps) doesn't move the body content_hash,
            // so 'unchanged' can still carry edge-relevant changes.
            const rec = records.getByPath(relativePath);
            if (rec) changedRecordIds.add(rec.recordId);
          }
          imported++;
          // Queue files: also reparse the queue_items slice. No-op for any
          // path outside `projects/<name>/queue{,-archive}.md`.
          const result = syncQueueFile(queueItems, relativePath, vaultDataPath, now);
          if (result) {
            queueItemsTouched +=
              result.inserted + result.updated + result.refreshed + result.deleted;
          }
        } catch (err) {
          errors++;
          const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
          process.stderr.write(`watcher: ${relativePath}: ${msg}\n`);
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    if (imported > 0 || deleted > 0) opts.onIndexChanged?.();

    // Scoped (incremental) edge rebuild for content-only, error-free batches;
    // full rebuild otherwise. An errored file's DB state is stale in an
    // unknown way — the conservative full pass keeps the GC sound.
    const scoped = !pathSetChanged && errors === 0;
    const edges = buildEdges(db, {
      vaultRoot: vaultDataPath,
      now,
      ...(scoped ? {scope: changedRecordIds} : {})
    });
    const embed = await embedPending(db, embedder);

    log(
      `reindex: imported=${imported} deleted=${deleted} errors=${errors} ` +
        `edges=${edges.edgesCreated} embed=${embed.embedded} queue_items=${queueItemsTouched}`
    );

    return {
      imported,
      deleted,
      errors,
      edgesCreated: edges.edgesCreated,
      embedded: embed.embedded,
      queueItemsTouched
    };
  };

  const flush = (): Promise<FlushSummary> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    let result!: FlushSummary;
    inFlight = inFlight
      .then(async () => {
        result = await drain();
      })
      .catch(err => {
        onError(err);
      });
    return inFlight.then(
      () =>
        result ?? {
          imported: 0,
          deleted: 0,
          errors: 0,
          edgesCreated: 0,
          embedded: 0,
          queueItemsTouched: 0
        }
    );
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, debounceMs);
  };

  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(vaultDataPath, {recursive: true}, (_eventType, filename) => {
      if (!filename) return;
      const relativePath = filename.toString().split(sep).join('/');
      if (shouldIgnore(relativePath)) return;
      pending.add(relativePath);
      schedule();
    });
    watcher.on('error', err => onError(err));
  } catch (err) {
    onError(err);
  }

  return {
    close() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      watcher?.close();
    },
    flush
  };
};
