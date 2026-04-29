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
import {importFile} from '../importer/import-file.ts';
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
    opts.onError ?? (err => process.stderr.write(`watcher: ${err instanceof Error ? err.message : String(err)}\n`));

  const records = new RecordsRepository(db);

  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  const drain = async (): Promise<FlushSummary> => {
    if (pending.size === 0) return {imported: 0, deleted: 0, errors: 0, edgesCreated: 0, embedded: 0};
    const batch = [...pending];
    pending.clear();

    const now = new Date().toISOString();
    let imported = 0;
    let deleted = 0;
    let errors = 0;

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
            }
            continue;
          }
          importFile(records, relativePath, abs, now);
          imported++;
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

    const edges = buildEdges(db, {vaultRoot: vaultDataPath, now});
    const embed = await embedPending(db, embedder);

    log(
      `reindex: imported=${imported} deleted=${deleted} errors=${errors} ` +
        `edges=${edges.edgesCreated} embed=${embed.embedded}`
    );

    return {
      imported,
      deleted,
      errors,
      edgesCreated: edges.edgesCreated,
      embedded: embed.embedded
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
    return inFlight.then(() => result ?? {imported: 0, deleted: 0, errors: 0, edgesCreated: 0, embedded: 0});
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
