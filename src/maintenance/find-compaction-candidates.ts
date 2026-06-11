// Folder-level scan that files `compaction_candidate` suggestions for
// folders whose piece count has crossed a threshold. Run on demand via
// `POST /maintenance/find-compaction-candidates` or as a future scheduled
// maintenance job.
//
// Per design constraint C7 (bounded running-file policy): some folders
// (atomized projects/<name>/decisions, learnings, queue) accumulate pieces
// that no longer pull individual weight but compress well as periodic
// summaries. This scan surfaces those folders so the agent
// (`/vault-compact <folder>`) can decide what to summarize and archive. The
// scan itself never writes content — only suggestions.
//
// Two filters keep fresh / archive-only material out of the qualifying set:
//   1. Folder exclusions (DEFAULT_SKIP_FOLDERS / DEFAULT_SKIP_PATH_SEGMENTS)
//      drop whole folders regardless of size — `logs` is archive-only and
//      never summarized at any age, `topics` is concept notes, `archive`/
//      `sync` are already-archived / mechanical.
//   2. A per-type hot-window gate (DEFAULT_COMPACTION_HOT_DAYS): a piece
//      counts toward its folder's threshold only once its `updated` age
//      exceeds its type's window, so fresh working-set pieces never trigger
//      a summarize-flag.
//
// Idempotency: a `compaction_candidate` of any status for the same
// `folder_path` blocks re-filing. Re-running is cheap.
//
// Auto-resolve: at scan time, every pending suggestion whose folder is
// NOT in the current qualifying set is promoted to `accepted` with
// `resolved_by='no-longer-eligible'` (typical trigger: `/vault-compact`
// archived enough pieces that the folder no longer crosses threshold).

import type {DatabaseSync} from 'node:sqlite';
import {SuggestionFiler} from '../importer/file-suggestions.ts';
import {RecordsRepository} from '../records/repository.ts';
import type {RecordType, VaultRecord} from '../records/types.ts';

/**
 * Folders excluded from the scan regardless of piece count (and regardless
 * of age — folder exclusion beats the hot-window gate).
 *
 * `topics` holds individual concept notes — high count reflects coverage,
 * not running-file growth. `logs` is archive-only: log pieces age out to
 * `logs/archive/<YYYY>/` via the retention scan and are never summarized,
 * so the whole folder is excluded here (this also keeps already-compacted
 * `_summary-*` fragments from re-flagging). `logs/sync` is mechanical
 * Obsidian-import output. Any folder containing `archive/` is already-archived.
 */
export const DEFAULT_SKIP_FOLDERS: readonly string[] = ['topics', 'logs'];
export const DEFAULT_SKIP_PATH_SEGMENTS: readonly string[] = ['archive', 'sync'];

/**
 * Per-type "hot window" in days. A piece counts toward its folder's
 * compaction threshold only once its `updated` age exceeds this window;
 * fresh working-set pieces never trigger a summarize-flag.
 *
 * Deliberately distinct from `DEFAULT_RETENTION_RULES` (the archive scan in
 * find-retention-candidates.ts): the two scans answer different questions —
 * *summarize-in-place* vs. *archive-out* — so their windows legitimately
 * differ. A `project` decision is never auto-archived (retention `null`) yet
 * IS summarize-eligible once cold, which is the whole point of the C7
 * running-file policy. `log` is intentionally absent: the `logs/` folder is
 * excluded wholesale by DEFAULT_SKIP_FOLDERS, so a log piece never reaches
 * this gate. Types not listed here fall back to {@link DEFAULT_HOT_DAYS}.
 */
export const DEFAULT_COMPACTION_HOT_DAYS: Partial<Record<RecordType, number>> = {
  query: 90,
  project: 180,
  permanent: 365
};

/** Hot window (days) for record types absent from {@link DEFAULT_COMPACTION_HOT_DAYS}. */
export const DEFAULT_HOT_DAYS = 180;

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
  /**
   * Per-type hot window (days) overrides. Merged over
   * `DEFAULT_COMPACTION_HOT_DAYS`; keys not provided keep the default.
   */
  hotDays?: Partial<Record<RecordType, number>>;
  /** Hot window (days) for types absent from the map. Default `DEFAULT_HOT_DAYS`. */
  defaultHotDays?: number;
  /**
   * Snooze window (days) applied to a prior *reject* of a folder's
   * `compaction_candidate` before it may re-surface. Default
   * `DEFAULT_SNOOZE_DAYS` (in file-suggestions.ts).
   */
  snoozeDays?: number;
  /** Override the timestamp written to suggestion rows + the age anchor (test injection). */
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

const MS_PER_DAY = 86_400_000;

const ageDays = (anchorIso: string, nowMs: number): number => {
  const t = Date.parse(anchorIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (nowMs - t) / MS_PER_DAY);
};

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
  const hotDays = {...DEFAULT_COMPACTION_HOT_DAYS, ...(options.hotDays ?? {})};
  const defaultHotDays = options.defaultHotDays ?? DEFAULT_HOT_DAYS;
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);

  const records = new RecordsRepository(db);
  const filer = new SuggestionFiler(db, 'compaction_candidate');

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
    // Hot-window gate: only pieces past their type's window count toward the
    // threshold (and toward the byte/date stats), so a folder full of fresh
    // working-set pieces never flags for summarization.
    const window = hotDays[r.type] ?? defaultHotDays;
    if (ageDays(r.updated, nowMs) < window) continue;
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
    const filed = filer.file(
      {
        folder_path: folder,
        piece_count: s.pieceCount,
        total_bytes: s.totalBytes,
        oldest_created: s.oldestCreated,
        newest_created: s.newestCreated
      },
      now,
      {snoozeDays: options.snoozeDays}
    );
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
    if (filer.accept({folder_path: row.folder_path}, 'no-longer-eligible', now) > 0) {
      summary.autoResolved++;
    }
  }

  summary.durationMs = Math.round(performance.now() - start);
  return summary;
};
