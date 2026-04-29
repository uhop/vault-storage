// Obsidian → vault-data incremental sync (Phase A.5 / cutover bridge).
//
// One-way: Obsidian is the source, vault-data is the target. Every source
// file goes through the same `transformFile` pass as a full migrate (status /
// type / tag remap, frontmatter backfill), then a 3-way merge against the
// recorded sync baseline decides whether to write or skip.
//
// Atomized files (target is a `<stem>/` folder of pieces, not a flat `.md`)
// are skipped — per-file sync would clobber the folder structure. The
// orchestrator reports them so the user can resolve manually.
//
// Source-side deletions never auto-delete the target. The orchestrator
// reports them as `removed_in_source` and leaves the target intact.

import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {parseFrontmatter} from '../markdown/frontmatter.ts';
import {walkMarkdown} from '../importer/walk.ts';
import {buildTagMap, type TagMap} from './tags.ts';
import {transformFile} from './transform.ts';
import {decideSync, SyncBaselineRepository, type SyncAction} from './sync-update.ts';

export interface SyncOptions {
  /** Obsidian-side directory tree (read-only). */
  source: string;
  /** vault-data tree (read+write). */
  target: string;
  db: DatabaseSync;
  /** Default: today as YYYY-MM-DD. Overridable for deterministic tests. */
  isoDate?: string;
  /** When true, don't write files or update baselines; report only. */
  dryRun?: boolean;
  /** When true, write a per-pass log under `logs/sync/` in the target tree. */
  writeLog?: boolean;
}

export interface SyncFileEntry {
  relativePath: string;
  action: SyncAction | 'removed_in_source';
  note?: string;
}

export interface SyncSummary {
  total: number;
  new: number;
  updated: number;
  unchanged: number;
  skippedLocallyNewer: number;
  skippedAtomized: number;
  removedInSource: number;
  files: SyncFileEntry[];
  durationMs: number;
  /** When `writeLog` is true and a log was written, the relative path of the log. */
  logPath?: string;
}

const collectRawTagsFromSource = (sourceRoot: string): Set<string> => {
  const out = new Set<string>();
  for (const file of walkMarkdown(sourceRoot)) {
    const text = readFileSync(file.absolutePath, 'utf8');
    const {data} = parseFrontmatter(text);
    const tags = data['tags'];
    if (Array.isArray(tags)) {
      for (const t of tags) if (typeof t === 'string') out.add(t);
    }
  }
  return out;
};

const isAtomizedTarget = (targetRoot: string, relativePath: string): boolean => {
  if (!relativePath.endsWith('.md')) return false;
  const stem = relativePath.slice(0, -'.md'.length);
  const folder = join(targetRoot, stem);
  if (!existsSync(folder)) return false;
  if (!statSync(folder).isDirectory()) return false;
  return existsSync(join(folder, '_about.md'));
};

/**
 * Run an incremental Obsidian → vault-data sync.
 *
 * The transform pipeline is shared with the full migrate (`transformFile`):
 * status / type / tag remap + frontmatter backfill. Tag canonicalization
 * uses a fresh tag map built from the current source tree; pre-seeding the
 * `tags_taxonomy` table is the full migrate's responsibility, not this one's.
 */
export const syncFromObsidian = (opts: SyncOptions): SyncSummary => {
  const start = performance.now();
  const isoDate = opts.isoDate ?? new Date().toISOString().slice(0, 10);
  const dryRun = opts.dryRun === true;

  if (!existsSync(opts.source)) throw new Error(`source does not exist: ${opts.source}`);
  if (!existsSync(opts.target)) throw new Error(`target does not exist: ${opts.target}`);

  const tagMap: TagMap = buildTagMap(collectRawTagsFromSource(opts.source));
  const baseline = new SyncBaselineRepository(opts.db);

  const files: SyncFileEntry[] = [];
  let total = 0;
  let countNew = 0;
  let countUpdated = 0;
  let countUnchanged = 0;
  let countSkippedLocallyNewer = 0;
  let countSkippedAtomized = 0;

  const sourcePathsSeen = new Set<string>();

  for (const file of walkMarkdown(opts.source)) {
    total++;
    sourcePathsSeen.add(file.relativePath);

    const sourceText = readFileSync(file.absolutePath, 'utf8');
    const transform = transformFile(sourceText, {
      relativePath: file.relativePath,
      tagMap,
      isoDate
    });

    const targetAbs = join(opts.target, file.relativePath);
    const target = existsSync(targetAbs) && statSync(targetAbs).isFile()
      ? readFileSync(targetAbs, 'utf8')
      : null;
    const targetIsAtomized = target === null && isAtomizedTarget(opts.target, file.relativePath);

    const decision = decideSync({
      transformed: transform.output,
      target,
      targetIsAtomized,
      baseline: baseline.get(file.relativePath)
    });

    if (!dryRun) {
      if (decision.action === 'new' || decision.action === 'updated') {
        mkdirSync(dirname(targetAbs), {recursive: true});
        writeFileSync(targetAbs, decision.contentToWrite!, 'utf8');
      }
      if (decision.newBaselineHash !== undefined) {
        baseline.upsert(file.relativePath, decision.newBaselineHash, isoDate);
      }
    }

    files.push({relativePath: file.relativePath, action: decision.action, note: decision.note});

    switch (decision.action) {
      case 'new':
        countNew++;
        break;
      case 'updated':
        countUpdated++;
        break;
      case 'unchanged':
        countUnchanged++;
        break;
      case 'skipped_locally_newer':
        countSkippedLocallyNewer++;
        break;
      case 'skipped_atomized':
        countSkippedAtomized++;
        break;
    }
  }

  // Source-side deletions: every file in the baseline that wasn't seen in
  // the current source pass. We don't auto-delete from the target.
  let removedInSource = 0;
  for (const recordedPath of baseline.listPaths()) {
    if (sourcePathsSeen.has(recordedPath)) continue;
    files.push({
      relativePath: recordedPath,
      action: 'removed_in_source',
      note: 'source file is gone; target left in place for manual review'
    });
    removedInSource++;
  }

  const summary: SyncSummary = {
    total,
    new: countNew,
    updated: countUpdated,
    unchanged: countUnchanged,
    skippedLocallyNewer: countSkippedLocallyNewer,
    skippedAtomized: countSkippedAtomized,
    removedInSource,
    files,
    durationMs: Math.round(performance.now() - start)
  };

  if (opts.writeLog && !dryRun) {
    summary.logPath = writeSyncLog(opts.target, summary);
  }

  return summary;
};

const writeSyncLog = (targetRoot: string, summary: SyncSummary): string => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const relativePath = `logs/sync/${stamp}.md`;
  const abs = join(targetRoot, relativePath);
  mkdirSync(dirname(abs), {recursive: true});

  const lines: string[] = [];
  lines.push('---');
  lines.push(`title: Obsidian sync ${stamp}`);
  lines.push('type: log');
  lines.push('tags: [sync, obsidian, cutover]');
  lines.push(`created: ${stamp.slice(0, 10)}`);
  lines.push(`updated: ${stamp.slice(0, 10)}`);
  lines.push('---');
  lines.push('');
  lines.push(
    `Sync from Obsidian: ${summary.new} new, ${summary.updated} updated, ` +
      `${summary.unchanged} unchanged, ${summary.skippedLocallyNewer} skipped (local edit), ` +
      `${summary.skippedAtomized} skipped (atomized), ${summary.removedInSource} removed in source. ` +
      `Total source files: ${summary.total}.`
  );
  lines.push('');

  const groups: Record<string, SyncFileEntry[]> = {};
  for (const f of summary.files) {
    (groups[f.action] ??= []).push(f);
  }
  for (const action of [
    'new',
    'updated',
    'skipped_locally_newer',
    'skipped_atomized',
    'removed_in_source',
    'unchanged'
  ] as const) {
    const list = groups[action];
    if (!list || list.length === 0) continue;
    lines.push(`## ${action} (${list.length})`);
    lines.push('');
    for (const f of list) {
      lines.push(`- \`${f.relativePath}\`${f.note ? ` — ${f.note}` : ''}`);
    }
    lines.push('');
  }

  writeFileSync(abs, lines.join('\n'), 'utf8');
  return relativePath;
};
