// Post-pull incremental reindex (per C14.1). When a host runs `git pull`
// to fetch remote commits, the working tree on disk jumps to a new HEAD;
// the file-watcher catches some changes but rename / batch-delete / merge
// scenarios are unreliable. This module provides the explicit reindex
// path: diff `meta.last_indexed_commit..HEAD` via git, dispatch per-file
// (modify/add → importFile, delete → records.delete, rename → UPDATE
// file_path then re-import).
//
// Falls back to a full importVault when the recorded last_indexed_commit
// is no longer in HEAD's ancestry — covers force-push / rebase scenarios
// where the diff range is meaningless. The full path is also the bootstrap
// path: when last_indexed_commit is unset, the first run does a full
// import and pins HEAD as the new anchor.

import type {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {buildEdges} from '../importer/build-edges.ts';
import {
  AgentEnrichmentStaleFiler,
  ArchiveCandidateFiler,
  TagSuggestionFiler
} from '../importer/file-suggestions.ts';
import {importFile} from '../importer/import-file.ts';
import {importVault} from '../importer/import.ts';
import {TagsImporter} from '../importer/import-tags.ts';
import {RecordsRepository} from '../records/repository.ts';
import {getCurrentHead, runGit} from '../util/git.ts';

export interface IncrementalReindexSummary {
  fromCommit: string | null;
  toCommit: string | null;
  changedFiles: number;
  imported: number;
  deleted: number;
  renamed: number;
  /** True when the diff range was invalid (history loss); a full importVault was run instead. */
  fellBack: boolean;
  durationMs: number;
}

export const getLastIndexedCommit = (db: DatabaseSync): string | null => {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'last_indexed_commit'`).get() as
    | {value: string}
    | undefined;
  return row?.value ?? null;
};

export const setLastIndexedCommit = (db: DatabaseSync, sha: string): void => {
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('last_indexed_commit', ?)`).run(sha);
};

export const clearLastIndexedCommit = (db: DatabaseSync): void => {
  db.prepare(`DELETE FROM meta WHERE key = 'last_indexed_commit'`).run();
};

type Change =
  | {kind: 'add' | 'modify' | 'delete'; path: string}
  | {kind: 'rename'; old: string; new: string};

/**
 * Parse `git diff --name-status -z --find-renames` output. The `-z`
 * flag null-separates fields and disables shell quoting, so we get
 * raw paths (safe with spaces / newlines).
 *
 * For most codes the format is `<status>\0<path>`. For renames it's
 * `R<percent>\0<old>\0<new>` — three tokens.
 */
const parseDiff = (output: string): Change[] => {
  const tokens = output.split('\x00').filter(s => s.length > 0);
  const changes: Change[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++];
    if (!code) continue;
    if (code.startsWith('R')) {
      const oldPath = tokens[i++];
      const newPath = tokens[i++];
      if (oldPath && newPath) changes.push({kind: 'rename', old: oldPath, new: newPath});
    } else if (code.startsWith('A')) {
      const path = tokens[i++];
      if (path) changes.push({kind: 'add', path});
    } else if (code.startsWith('M')) {
      const path = tokens[i++];
      if (path) changes.push({kind: 'modify', path});
    } else if (code.startsWith('D')) {
      const path = tokens[i++];
      if (path) changes.push({kind: 'delete', path});
    } else {
      // Skip unknown codes (e.g. T for type changes, C for copies) — but
      // consume their path token to keep the cursor aligned.
      i++;
    }
  }
  return changes;
};

const isMd = (path: string): boolean => path.endsWith('.md');

/**
 * Run an incremental reindex from `last_indexed_commit` to current HEAD.
 * On history loss (commit not in ancestry) falls back to a full
 * importVault and re-pins the anchor. On any other error returns the
 * partial summary with what was completed before the failure.
 */
export const incrementalReindex = async (
  db: DatabaseSync,
  vaultDataPath: string
): Promise<IncrementalReindexSummary> => {
  const start = performance.now();
  const summary: IncrementalReindexSummary = {
    fromCommit: getLastIndexedCommit(db),
    toCommit: null,
    changedFiles: 0,
    imported: 0,
    deleted: 0,
    renamed: 0,
    fellBack: false,
    durationMs: 0
  };

  const head = await getCurrentHead(vaultDataPath);
  summary.toCommit = head;

  // Bootstrap or force-rebuild path: no anchor, or no git repo at all.
  // Run a full importVault and pin HEAD as the new anchor.
  if (head === null || summary.fromCommit === null) {
    const full = importVault(db, vaultDataPath);
    if (head !== null) setLastIndexedCommit(db, head);
    summary.fellBack = true;
    summary.changedFiles = full.total;
    summary.imported = full.inserted + full.updated;
    summary.durationMs = Math.round(performance.now() - start);
    return summary;
  }

  // Already up to date.
  if (summary.fromCommit === head) {
    summary.durationMs = Math.round(performance.now() - start);
    return summary;
  }

  // Diff the range. -z null-separates; --find-renames detects renames;
  // -- limits to the working tree (no submodule traversal).
  const diff = await runGit(vaultDataPath, [
    'diff',
    '--name-status',
    '-z',
    '--find-renames',
    `${summary.fromCommit}..${head}`
  ]);

  if (diff.exitCode !== 0) {
    // History loss (e.g. force-push or rebase): fall back to full reindex.
    const full = importVault(db, vaultDataPath);
    setLastIndexedCommit(db, head);
    summary.fellBack = true;
    summary.changedFiles = full.total;
    summary.imported = full.inserted + full.updated;
    summary.durationMs = Math.round(performance.now() - start);
    return summary;
  }

  const changes = parseDiff(diff.stdout);
  summary.changedFiles = changes.filter(
    c => isMd(c.kind === 'rename' ? c.new : c.path)
  ).length;

  const records = new RecordsRepository(db);
  const tags = new TagsImporter(db);
  const agentStale = new AgentEnrichmentStaleFiler(db);
  const tagSuggestion = new TagSuggestionFiler(db);
  const archiveCandidate = new ArchiveCandidateFiler(db);
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    for (const c of changes) {
      // Filter to .md files. For renames, both sides need consideration —
      // a .md → .md rename is interesting; .md → other or other → .md
      // means delete-then-import on the .md side.
      if (c.kind === 'rename') {
        const newIsMd = isMd(c.new);
        const oldIsMd = isMd(c.old);
        if (oldIsMd && newIsMd) {
          // Preserve record_id by updating the path key, then re-import
          // to refresh content_hash / agent block / etc.
          db.prepare('UPDATE records SET file_path = ? WHERE file_path = ?').run(c.new, c.old);
          const abs = join(vaultDataPath, c.new);
          if (existsSync(abs)) {
            importFile(records, c.new, abs, now, {
              tags,
              agentStale,
              tagSuggestion,
              archiveCandidate
            });
          }
          summary.renamed++;
          summary.imported++;
        } else if (oldIsMd) {
          // .md disappeared (renamed to non-.md).
          const r = records.getByPath(c.old);
          if (r) {
            records.delete(r.recordId);
            summary.deleted++;
          }
        } else if (newIsMd) {
          // New .md appeared (renamed from non-.md).
          const abs = join(vaultDataPath, c.new);
          if (existsSync(abs)) {
            importFile(records, c.new, abs, now, {
              tags,
              agentStale,
              tagSuggestion,
              archiveCandidate
            });
            summary.imported++;
          }
        }
      } else if (!isMd(c.path)) {
        // Skip non-md adds/modifies/deletes.
      } else if (c.kind === 'delete') {
        const r = records.getByPath(c.path);
        if (r) {
          records.delete(r.recordId);
          summary.deleted++;
        }
      } else {
        // add / modify
        const abs = join(vaultDataPath, c.path);
        if (existsSync(abs)) {
          importFile(records, c.path, abs, now, {
            tags,
            agentStale,
            tagSuggestion,
            archiveCandidate
          });
          summary.imported++;
        }
      }
    }
    setLastIndexedCommit(db, head);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Refresh edges after the per-file dispatch (cheap; build-edges is
  // idempotent and limited to the current record set).
  buildEdges(db, {vaultRoot: vaultDataPath, now});

  summary.durationMs = Math.round(performance.now() - start);
  return summary;
};
