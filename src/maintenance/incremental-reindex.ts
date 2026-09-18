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
import {buildEdges, buildEdgesAsync} from '../importer/build-edges.ts';
import {SuggestionFiler} from '../importer/file-suggestions.ts';
import {importFile} from '../importer/import-file.ts';
import {importVaultAsync} from '../importer/import.ts';
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
    {value: string} | undefined;
  return row?.value ?? null;
};

export const setLastIndexedCommit = (db: DatabaseSync, sha: string): void => {
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('last_indexed_commit', ?)`).run(sha);
};

export const clearLastIndexedCommit = (db: DatabaseSync): void => {
  db.prepare(`DELETE FROM meta WHERE key = 'last_indexed_commit'`).run();
};

type Change =
  {kind: 'add' | 'modify' | 'delete'; path: string} | {kind: 'rename'; old: string; new: string};

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
 * Uncommitted `.md` changes as {@link Change}s, classified by what is on disk
 * and in the index rather than by git's status letters: a path on disk is an
 * add when no record has it and a modify otherwise; a path gone from disk is a
 * delete when a record still has it. Only a staged rename keeps its pairing.
 */
const workingTreeChanges = async (db: DatabaseSync, vaultDataPath: string): Promise<Change[]> => {
  const status = await runGit(vaultDataPath, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all'
  ]);
  if (status.exitCode !== 0) throw new Error(`git status failed: ${status.stderr.trim()}`);
  const records = new RecordsRepository(db);
  const tokens = status.stdout.split('\x00');
  const changes: Change[] = [];
  for (let i = 0; i < tokens.length; ++i) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) continue;
    const path = entry.slice(3);
    // -z puts a rename's source in the next token, after the destination.
    if (entry[0] === 'R') {
      const old = tokens[++i] ?? '';
      if (isMd(old) && records.getByPath(old)) {
        changes.push(isMd(path) ? {kind: 'rename', old, new: path} : {kind: 'delete', path: old});
        continue;
      }
    }
    if (!isMd(path)) continue;
    const known = records.getByPath(path) !== null;
    if (existsSync(join(vaultDataPath, path))) {
      changes.push({kind: known ? 'modify' : 'add', path});
    } else if (known) {
      changes.push({kind: 'delete', path});
    }
  }
  return changes;
};

export interface IncrementalReindexOptions {
  /**
   * Also import uncommitted `.md` changes. Startup needs it: a file edited
   * while the server was down is dirty, git-sync would commit it and advance
   * the anchor past it, and no watcher saw it change.
   */
  workingTree?: boolean;
}

const inFlight = new WeakMap<DatabaseSync, Promise<unknown>>();

/**
 * Run an incremental reindex from `last_indexed_commit` to current HEAD.
 * On history loss (commit not in ancestry) falls back to a full
 * importVault and re-pins the anchor. On any other error returns the
 * partial summary with what was completed before the failure.
 *
 * Calls against one database run one at a time: a full import yields, and a
 * second reindex interleaved with it would diff an anchor about to move.
 */
export const incrementalReindex = (
  db: DatabaseSync,
  vaultDataPath: string,
  opts: IncrementalReindexOptions = {}
): Promise<IncrementalReindexSummary> => {
  const run = (inFlight.get(db) ?? Promise.resolve()).then(() =>
    runIncrementalReindex(db, vaultDataPath, opts)
  );
  inFlight.set(
    db,
    run.catch(() => {})
  );
  return run;
};

const runIncrementalReindex = async (
  db: DatabaseSync,
  vaultDataPath: string,
  opts: IncrementalReindexOptions
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

  const fullReindex = async (): Promise<IncrementalReindexSummary> => {
    const full = await importVaultAsync(db, vaultDataPath);
    if (head !== null) setLastIndexedCommit(db, head);
    summary.fellBack = true;
    summary.changedFiles = full.total;
    summary.imported = full.inserted + full.updated;
    summary.durationMs = Math.round(performance.now() - start);
    return summary;
  };

  // Bootstrap or force-rebuild path: no anchor, or no git repo at all.
  if (head === null || summary.fromCommit === null) return fullReindex();

  const changes: Change[] = [];
  if (summary.fromCommit !== head) {
    // Diff the range. -z null-separates; --find-renames detects renames.
    const diff = await runGit(vaultDataPath, [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      `${summary.fromCommit}..${head}`
    ]);
    // History loss (e.g. force-push or rebase).
    if (diff.exitCode !== 0) return fullReindex();
    changes.push(...parseDiff(diff.stdout));
  }
  if (opts.workingTree) changes.push(...(await workingTreeChanges(db, vaultDataPath)));

  if (summary.fromCommit === head && !changes.length) {
    summary.durationMs = Math.round(performance.now() - start);
    return summary;
  }

  summary.changedFiles = changes.filter(c => isMd(c.kind === 'rename' ? c.new : c.path)).length;

  const records = new RecordsRepository(db);
  const tags = new TagsImporter(db);
  const agentStale = new SuggestionFiler(db, 'agent_enrichment_stale');
  const tagSuggestion = new SuggestionFiler(db, 'tag_suggestion');
  const archiveCandidate = new SuggestionFiler(db, 'archive_candidate');
  const now = new Date().toISOString();

  // Pure-modify batches rebuild edges for just the touched records; any
  // add / delete / rename changes the path set, which can flip wikilink
  // resolution (basename uniqueness, folder fallback) for records outside
  // the batch — those fall back to the full edge rebuild.
  let pathSetChanged = false;
  const changedRecordIds = new Set<string>();

  db.exec('BEGIN');
  try {
    for (const c of changes) {
      // Filter to .md files. For renames, both sides need consideration —
      // a .md → .md rename is interesting; .md → other or other → .md
      // means delete-then-import on the .md side.
      if (c.kind === 'rename') {
        const newIsMd = isMd(c.new);
        const oldIsMd = isMd(c.old);
        if (oldIsMd || newIsMd) pathSetChanged = true;
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
        pathSetChanged = true;
        const r = records.getByPath(c.path);
        if (r) {
          records.delete(r.recordId);
          summary.deleted++;
        }
      } else {
        // add / modify
        if (c.kind === 'add') pathSetChanged = true;
        const abs = join(vaultDataPath, c.path);
        if (existsSync(abs)) {
          importFile(records, c.path, abs, now, {
            tags,
            agentStale,
            tagSuggestion,
            archiveCandidate
          });
          summary.imported++;
          if (c.kind === 'modify') {
            const rec = records.getByPath(c.path);
            if (rec) changedRecordIds.add(rec.recordId);
          }
        } else if (c.kind === 'modify') {
          // Modified in git but absent on disk (e.g. removed since the
          // commit) — path set is effectively changing; stay conservative.
          pathSetChanged = true;
        }
      }
    }
    setLastIndexedCommit(db, head);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Refresh edges after the per-file dispatch. Pure-modify batches use the
  // scoped (incremental) rebuild; anything that changed the path set runs
  // the full idempotent pass.
  if (pathSetChanged) await buildEdgesAsync(db, {vaultRoot: vaultDataPath, now});
  else buildEdges(db, {vaultRoot: vaultDataPath, now, scope: changedRecordIds});

  summary.durationMs = Math.round(performance.now() - start);
  return summary;
};
