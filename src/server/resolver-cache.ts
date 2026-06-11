import type {DatabaseSync} from 'node:sqlite';
import {WikilinkResolver} from '../importer/resolver.ts';

interface PathEntry {
  recordId: string;
  filePath: string;
}

export interface ResolvedView {
  resolver: WikilinkResolver;
  /** record_id → file_path for the records the resolver was built from. */
  pathById: ReadonlyMap<string, string>;
}

/**
 * Lazily-built, explicitly-invalidated wikilink resolver shared across
 * requests. `/resolve` used to load every record (bodies included) and build
 * a fresh resolver per call — and the UI preview calls it once per wikilink
 * in a rendered note. The resolver keys on file paths alone, so the cache
 * holds only `(record_id, file_path)` pairs — no bodies are retained.
 *
 * Invalidation is event-driven, not fingerprint-driven: every path that
 * mutates the records table (watcher drain, inline imports on the vault /
 * sections write handlers, incremental reindex, obsidian sync) calls
 * `invalidate()`. Building is cheap (one path-only scan), so spurious
 * invalidation costs little; a MISSED invalidation would serve stale
 * resolution, so new write paths must remember to call it.
 */
export class ResolverCache {
  readonly #db: DatabaseSync;
  #view: ResolvedView | null = null;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  get(): ResolvedView {
    if (this.#view === null) {
      const rows = this.#db
        .prepare('SELECT record_id, file_path FROM records')
        .all() as unknown[] as {record_id: string; file_path: string}[];
      const entries: PathEntry[] = rows.map(r => ({recordId: r.record_id, filePath: r.file_path}));
      const resolver = new WikilinkResolver(entries);
      const pathById = new Map(entries.map(e => [e.recordId, e.filePath]));
      this.#view = {resolver, pathById};
    }
    return this.#view;
  }

  invalidate(): void {
    this.#view = null;
  }
}
