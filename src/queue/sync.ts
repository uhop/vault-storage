// Integration helpers connecting the queue parser/repo to the watcher and the
// HTTP layer. Two callers:
//
//   - watcher.drain(): per modified path, calls syncQueueFile (file present)
//     or dropQueueFile (file removed). Both no-op when the path isn't a queue
//     file, so the watcher can pass every changed path through unconditionally.
//
//   - POST /maintenance/reindex-queues: calls reindexAllQueues to walk the
//     vault, parse every queue.md / queue-archive.md it finds, and apply.
//     Also drops any slices in the DB whose source file no longer exists on
//     disk — the corrective sweep when the watcher missed an event.

import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {parseQueueFile} from './parse.ts';
import {QueueItemsRepository, type ApplyResult} from './repo.ts';

/** Match `projects/<project>/queue.md` or `projects/<project>/queue-archive.md`. */
const QUEUE_FILE_RE = /^projects\/([^/]+)\/(queue|queue-archive)\.md$/;

export interface QueueFileMatch {
  project: string;
  /** The vault-relative path, unchanged from input. */
  sourceFile: string;
}

/** Returns project/source descriptor for a queue file, or null for any other path. */
export const matchQueueFile = (relativePath: string): QueueFileMatch | null => {
  const m = QUEUE_FILE_RE.exec(relativePath);
  if (!m) return null;
  return {project: m[1] as string, sourceFile: relativePath};
};

/**
 * Reparse a single queue file from disk and apply the result. No-op (returns
 * null) when `relativePath` isn't a queue file. Throws on filesystem or parse
 * errors so the watcher's per-batch error path can record them.
 */
export const syncQueueFile = (
  repo: QueueItemsRepository,
  relativePath: string,
  vaultDataPath: string,
  now: string = new Date().toISOString()
): ApplyResult | null => {
  const match = matchQueueFile(relativePath);
  if (!match) return null;
  const abs = join(vaultDataPath, relativePath);
  if (!existsSync(abs)) {
    // Path resolves to a queue file but the file is gone — treat as drop.
    const deleted = repo.deleteSlice(match.project, match.sourceFile);
    return {inserted: 0, updated: 0, refreshed: 0, deleted};
  }
  const content = readFileSync(abs, 'utf8');
  const parsed = parseQueueFile(match.project, match.sourceFile, content);
  return repo.applyParsed(match.project, match.sourceFile, parsed, now);
};

/**
 * Drop the slice for a queue file that was deleted on disk. No-op (returns
 * null) when the path isn't a queue file. Returns the row count that was
 * dropped (0 when the slice was already empty).
 */
export const dropQueueFile = (repo: QueueItemsRepository, relativePath: string): number | null => {
  const match = matchQueueFile(relativePath);
  if (!match) return null;
  return repo.deleteSlice(match.project, match.sourceFile);
};

export interface ReindexQueuesSummary {
  /** Number of `projects/*` directories scanned. */
  projectsScanned: number;
  /** Queue-flavored files found and parsed (queue.md + queue-archive.md). */
  filesProcessed: number;
  inserted: number;
  updated: number;
  refreshed: number;
  /** Rows removed across all sources — includes the per-slice diff deletes
   *  plus slices for files no longer on disk. */
  deleted: number;
  /** Slices dropped because the file disappeared since the last reindex. */
  staleSlicesDropped: number;
  errors: Array<{path: string; message: string}>;
  durationMs: number;
}

const QUEUE_BASENAMES = new Set(['queue.md', 'queue-archive.md']);

// Full vault sweep: re-parse every `projects/<name>/queue.md` and
// `queue-archive.md`, apply, and additionally drop DB slices whose source
// files no longer exist. Used by `POST /maintenance/reindex-queues` and on
// first run after the migration lands (the watcher only reacts to changes;
// existing files need a manual kick to populate the table).
export const reindexAllQueues = (
  repo: QueueItemsRepository,
  vaultDataPath: string,
  now: string = new Date().toISOString()
): ReindexQueuesSummary => {
  const start = Date.now();
  const summary: ReindexQueuesSummary = {
    projectsScanned: 0,
    filesProcessed: 0,
    inserted: 0,
    updated: 0,
    refreshed: 0,
    deleted: 0,
    staleSlicesDropped: 0,
    errors: [],
    durationMs: 0
  };

  // Track which (project, source_file) slices were touched in this sweep
  // so we can drop slices for files that disappeared.
  const seen = new Set<string>();
  const sliceKey = (project: string, sourceFile: string): string => `${project}\0${sourceFile}`;

  const projectsRoot = join(vaultDataPath, 'projects');
  let projects: string[];
  try {
    projects = readdirSync(projectsRoot, {withFileTypes: true})
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    // No projects/ folder yet — nothing to do.
    summary.durationMs = Date.now() - start;
    return summary;
  }

  for (const project of projects) {
    ++summary.projectsScanned;
    let entries;
    try {
      entries = readdirSync(join(projectsRoot, project), {withFileTypes: true});
    } catch (err) {
      summary.errors.push({
        path: `projects/${project}/`,
        message: err instanceof Error ? err.message : String(err)
      });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!QUEUE_BASENAMES.has(entry.name)) continue;
      const relativePath = `projects/${project}/${entry.name}`;
      try {
        const result = syncQueueFile(repo, relativePath, vaultDataPath, now);
        if (result === null) continue;
        ++summary.filesProcessed;
        summary.inserted += result.inserted;
        summary.updated += result.updated;
        summary.refreshed += result.refreshed;
        summary.deleted += result.deleted;
        seen.add(sliceKey(project, relativePath));
      } catch (err) {
        summary.errors.push({
          path: relativePath,
          message: err instanceof Error ? err.message : String(err)
        });
      }
    }
  }

  // Drop slices whose source file is no longer on disk. (For instance, a
  // queue-archive.md that was deleted between the previous reindex and this
  // one, or a whole project folder that went away.)
  const present = repo.listAll();
  const dropped = new Set<string>();
  for (const row of present) {
    const key = sliceKey(row.project, row.source_file);
    if (seen.has(key) || dropped.has(key)) continue;
    const removed = repo.deleteSlice(row.project, row.source_file);
    if (removed > 0) {
      summary.deleted += removed;
      ++summary.staleSlicesDropped;
    }
    dropped.add(key);
  }

  summary.durationMs = Date.now() - start;
  return summary;
};
