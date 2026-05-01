// Folder-level scan that files `compaction_candidate` suggestions for
// folders whose piece count has crossed a threshold. Run on demand via
// `POST /maintenance/find-compaction-candidates` or as a future scheduled
// maintenance job.
//
// Per design constraint C7 (bounded running-file policy): some folders
// (logs, atomized projects/<name>/decisions, learnings, queue, done)
// accumulate pieces that no longer pull individual weight but compress
// well as periodic summaries. This scan surfaces those folders so the
// agent (`/vault-compact <folder>`) can decide what to summarize and
// archive. The scan itself never writes content — only suggestions.
//
// Idempotency: a `compaction_candidate` of any status for the same
// `folder_path` blocks re-filing. Re-running is cheap.
//
// Auto-resolve: at scan time, every pending suggestion whose folder is
// NOT in the current qualifying set is promoted to `accepted` with
// `resolved_by='no-longer-eligible'` (typical trigger: `/vault-compact`
// archived enough pieces that the folder no longer crosses threshold).

import type {DatabaseSync} from 'node:sqlite';
import {CompactionCandidateFiler} from '../importer/file-suggestions.ts';
import {RecordsRepository} from '../records/repository.ts';
import type {VaultRecord} from '../records/types.ts';

/**
 * Folders excluded from the scan regardless of piece count.
 *
 * `topics` holds individual concept notes — high count reflects coverage,
 * not running-file growth. `logs/sync` is mechanical Obsidian-import
 * output. Any folder containing `archive/` is already-archived.
 */
export const DEFAULT_SKIP_FOLDERS: readonly string[] = ['topics'];
export const DEFAULT_SKIP_PATH_SEGMENTS: readonly string[] = ['archive', 'sync'];

export interface FindCompactionCandidatesOptions {
  /**
   * Minimum piece count for a folder to qualify. Default 30 — picked from
   * the live-vault distribution (2026-05-01): catches logs (87) and the
   * six largest atomized project folders (decisions/learnings spans 31-58
   * pieces) while leaving smaller folders (5-20 pieces) below threshold.
   * Lower for an aggressive sweep; raise to focus only on the biggest.
   */
  minPieceCount?: number;
  /** Folders to always skip. Default `DEFAULT_SKIP_FOLDERS`. */
  skipFolders?: readonly string[];
  /**
   * Path segments that, when present in a folder, exclude it. Default
   * `DEFAULT_SKIP_PATH_SEGMENTS`. Matched as exact path segments, not
   * substrings — a folder named `archived-2026` is fine; a folder
   * containing `/archive/` or `/sync/` is excluded.
   */
  skipPathSegments?: readonly string[];
  /** Override the timestamp written to suggestion rows (test injection). */
  now?: string;
}

export interface FindCompactionCandidatesSummary {
  /** Folders evaluated (post-skip-filters). */
  scanned: number;
  /** Folders that crossed threshold this pass. */
  qualifying: number;
  /** New `compaction_candidate` suggestions filed. */
  filed: number;
  /** Pending suggestions auto-resolved because their folder no longer qualifies. */
  autoResolved: number;
  durationMs: number;
}

interface FolderStats {
  pieceCount: number;
  totalBytes: number;
  oldestCreated: string;
  newestCreated: string;
}

const folderOf = (filePath: string): string | null => {
  const idx = filePath.lastIndexOf('/');
  if (idx < 0) return null;
  return filePath.slice(0, idx);
};

const containsSkippedSegment = (folder: string, segments: readonly string[]): boolean => {
  const parts = folder.split('/');
  return parts.some(p => segments.includes(p));
};

/**
 * Scan every record's `file_path`, group by folder, and file
 * `compaction_candidate` suggestions for folders crossing the threshold.
 * Auto-resolves stale pendings whose folder no longer qualifies.
 */
export const findCompactionCandidates = (
  db: DatabaseSync,
  options: FindCompactionCandidatesOptions = {}
): FindCompactionCandidatesSummary => {
  const minPieceCount = options.minPieceCount ?? 30;
  const skipFolders = new Set<string>(options.skipFolders ?? DEFAULT_SKIP_FOLDERS);
  const skipPathSegments = options.skipPathSegments ?? DEFAULT_SKIP_PATH_SEGMENTS;
  const now = options.now ?? new Date().toISOString();

  const records = new RecordsRepository(db);
  const filer = new CompactionCandidateFiler(db);

  const start = performance.now();
  const summary: FindCompactionCandidatesSummary = {
    scanned: 0,
    qualifying: 0,
    filed: 0,
    autoResolved: 0,
    durationMs: 0
  };

  const stats = new Map<string, FolderStats>();
  for (const r of records.listAll() as VaultRecord[]) {
    const folder = folderOf(r.filePath);
    if (folder === null) continue;
    if (skipFolders.has(folder)) continue;
    if (containsSkippedSegment(folder, skipPathSegments)) continue;
    const cur = stats.get(folder);
    if (cur) {
      cur.pieceCount++;
      cur.totalBytes += r.body.length;
      if (r.created < cur.oldestCreated) cur.oldestCreated = r.created;
      if (r.created > cur.newestCreated) cur.newestCreated = r.created;
    } else {
      stats.set(folder, {
        pieceCount: 1,
        totalBytes: r.body.length,
        oldestCreated: r.created,
        newestCreated: r.created
      });
    }
  }

  summary.scanned = stats.size;

  const qualifying = new Set<string>();
  for (const [folder, s] of stats) {
    if (s.pieceCount < minPieceCount) continue;
    qualifying.add(folder);
    summary.qualifying++;
    const filed = filer.fileCandidate({
      folderPath: folder,
      pieceCount: s.pieceCount,
      totalBytes: s.totalBytes,
      oldestCreated: s.oldestCreated,
      newestCreated: s.newestCreated,
      now
    });
    if (filed) summary.filed++;
  }

  // Auto-resolve pending suggestions whose folder no longer qualifies.
  const pending = db
    .prepare(
      `SELECT json_extract(payload, '$.folder_path') AS folder_path FROM suggestions
        WHERE kind = 'compaction_candidate' AND status = 'pending'`
    )
    .all() as Array<{folder_path: string}>;
  for (const row of pending) {
    if (qualifying.has(row.folder_path)) continue;
    if (filer.autoAcceptForFolder(row.folder_path, now)) summary.autoResolved++;
  }

  summary.durationMs = Math.round(performance.now() - start);
  return summary;
};
