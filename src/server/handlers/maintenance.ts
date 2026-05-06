import {createReadStream, readdirSync, statSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {cleanupLint} from '../../maintenance/cleanup-lint.ts';
import {cleanupTagAliases} from '../../maintenance/cleanup-tag-aliases.ts';
import {findCompactionCandidates} from '../../maintenance/find-compaction-candidates.ts';
import {findDuplicates} from '../../maintenance/find-duplicates.ts';
import {findRetentionCandidates} from '../../maintenance/find-retention-candidates.ts';
import {findUpgradeSignals} from '../../maintenance/find-upgrade-signals.ts';
import {clearLastIndexedCommit, incrementalReindex} from '../../maintenance/incremental-reindex.ts';
import {scanRawInbox} from '../../maintenance/raw-inbox.ts';
import {listFolder} from '../../maintenance/folder-listing.ts';
import {embedPending, type EmbedSummary} from '../../embeddings/embed-pass.ts';
import type {Embedder} from '../../embeddings/types.ts';
import {snapshotDb} from '../snapshot.ts';
import {readBodyText} from '../body.ts';
import {sendError, sendJson, sendNoContent} from '../responses.ts';
import type {Handler} from '../router.ts';

interface MaintenanceDeps {
  db: DatabaseSync;
}

interface SnapshotDeps {
  db: DatabaseSync;
  vaultDataPath: string;
}

interface EmbedDeps {
  db: DatabaseSync;
  embedder: Embedder;
}

const parsePositiveFloat = (raw: string | undefined, fallback: number): number | null => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
};

const parsePositiveInt = (raw: string | undefined, fallback: number): number | null => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
};

/**
 * POST /maintenance/find-duplicates?max_distance=&per_record=&limit=
 *
 * Run the pairwise vector-similarity scan and file `duplicate` suggestions
 * for record pairs above the threshold. Idempotent across runs (won't
 * refile pairs that already have a suggestion in any status).
 *
 * Returns the scan summary `{scanned, skippedUnembedded, pairsFound, filed,
 * durationMs}`.
 */
export const findDuplicatesHandler =
  (deps: MaintenanceDeps): Handler =>
  ctx => {
    const maxDistance = parsePositiveFloat(ctx.query['max_distance'], 0.1);
    if (maxDistance === null) {
      sendError(ctx.res, 400, 'bad_request', 'max_distance must be a non-negative number');
      return;
    }
    const perRecord = parsePositiveInt(ctx.query['per_record'], 10);
    if (perRecord === null) {
      sendError(ctx.res, 400, 'bad_request', 'per_record must be a positive integer');
      return;
    }
    const minBodyLength = parsePositiveInt(ctx.query['min_body_length'], 200);
    if (minBodyLength === null) {
      sendError(ctx.res, 400, 'bad_request', 'min_body_length must be a positive integer');
      return;
    }
    const limitRaw = ctx.query['limit'];
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      const parsed = parsePositiveInt(limitRaw, 0);
      if (parsed === null || parsed === 0) {
        sendError(ctx.res, 400, 'bad_request', 'limit must be a positive integer');
        return;
      }
      limit = parsed;
    }

    const summary = findDuplicates(deps.db, {maxDistance, perRecord, limit, minBodyLength});
    sendJson(ctx.res, 200, summary);
  };

/**
 * POST /maintenance/find-compaction-candidates?min_piece_count=
 *
 * Group every record by parent folder and file `compaction_candidate`
 * suggestions for folders whose piece count crosses the threshold
 * (default 30). Skips `topics/` (concept notes, not running-files) and
 * any path containing `/archive/` or `/sync/` segments. Auto-resolves
 * any pending suggestion whose folder no longer qualifies (post-compact
 * sweep).
 *
 * Returns `{scanned, qualifying, filed, autoResolved, durationMs}`.
 */
export const findCompactionCandidatesHandler =
  (deps: MaintenanceDeps): Handler =>
  ctx => {
    const minPieceCount = parsePositiveInt(ctx.query['min_piece_count'], 30);
    if (minPieceCount === null) {
      sendError(ctx.res, 400, 'bad_request', 'min_piece_count must be a positive integer');
      return;
    }
    const summary = findCompactionCandidates(deps.db, {minPieceCount});
    sendJson(ctx.res, 200, summary);
  };

/**
 * POST /maintenance/find-retention-candidates
 *
 * Per-type calendar retention scan. Files `archive_candidate`
 * suggestions for records past their type's age threshold (default
 * thresholds per design: log > 90d, query > 180d, fleeting > 30d,
 * queue-item with status='done' for > 90d, bug-report with
 * status='done' for > 180d). Idempotent on `(record_id, status='pending')`.
 *
 * Returns `{scanned, qualifying, filed, durationMs}`.
 */
export const findRetentionCandidatesHandler =
  (deps: MaintenanceDeps): Handler =>
  ctx => {
    const summary = findRetentionCandidates(deps.db);
    sendJson(ctx.res, 200, summary);
    void ctx;
  };

/**
 * POST /maintenance/snapshot
 *
 * Produce a single-file gzip-compressed SQLite snapshot of the live DB
 * via VACUUM INTO (safe under concurrent reads/writes on WAL). Default
 * destination: `${VAULT_DATA_PATH}/.snapshots/vault.sqlite.gz`. Override
 * with `?path=<vault-relative-path>` (must stay under VAULT_DATA_PATH).
 *
 * Returns `{path, bytes, durationMs}`.
 *
 * Tier 2 backup per C2: pair this with a host-side cron + `aws s3 cp`,
 * or set VAULT_BACKUP_S3_BUCKET to enable the auto-poll loop that does
 * the same internally.
 */
/**
 * POST /maintenance/find-upgrade-signals
 *
 * Inspect the live DB and file `inefficiency_detected` /
 * `infrastructure_upgrade` suggestions for any tripped signal:
 * record_count_high / record_count_migrate, db_bytes_high,
 * edge_fanout_high, review_backlog_high. Idempotent on
 * `(kind, signal, status='pending')`. Reports only — never auto-migrates.
 *
 * Returns `{scanned, tripped, filed, durationMs, observed}`.
 */
export const findUpgradeSignalsHandler =
  (deps: MaintenanceDeps): Handler =>
  ctx => {
    const summary = findUpgradeSignals(deps.db);
    sendJson(ctx.res, 200, summary);
    void ctx;
  };

/**
 * POST /maintenance/incremental-reindex[?full=true]
 *
 * Re-import only the markdown files that changed between
 * `meta.last_indexed_commit` and current HEAD. Renames preserve
 * record_id; deletes drop the row; modifies/adds run through the
 * normal importFile path (tags, agent block, suggestions, edges).
 *
 * Falls back to a full importVault when the recorded anchor is no
 * longer in HEAD's ancestry (force-push / rebase) — and on bootstrap
 * runs a full import to pin HEAD. `?full=true` forces the full path
 * regardless of state (the explicit escape hatch).
 *
 * Returns `{fromCommit, toCommit, changedFiles, imported, deleted,
 * renamed, fellBack, durationMs}`.
 */
export const incrementalReindexHandler =
  (deps: SnapshotDeps): Handler =>
  async ctx => {
    if (ctx.query['full'] === 'true') clearLastIndexedCommit(deps.db);
    try {
      const summary = await incrementalReindex(deps.db, deps.vaultDataPath);
      sendJson(ctx.res, 200, summary);
    } catch (err) {
      sendError(
        ctx.res,
        500,
        'incremental_reindex_failed',
        `incremental reindex failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

/**
 * POST /maintenance/run-all
 *
 * Bundle for "I want all the maintenance scans to refresh their queues."
 * Calls find-duplicates, find-compaction-candidates, find-retention-
 * candidates, and find-upgrade-signals with default knobs, returns each
 * scan's summary keyed by name. Doesn't run anything destructive (no
 * cleanup-lint, no compaction archive). Pairs with the dashboard's
 * "Run scans" button so the user can refresh suggestion queues without
 * dropping to the shell for four separate POSTs.
 *
 * Returns `{duplicates, compaction, retention, upgrade, durationMs}`.
 */
export const runAllScansHandler =
  (deps: MaintenanceDeps): Handler =>
  ctx => {
    const start = Date.now();
    const duplicates = findDuplicates(deps.db, {
      maxDistance: 0.1,
      perRecord: 10,
      minBodyLength: 200
    });
    const compaction = findCompactionCandidates(deps.db, {minPieceCount: 30});
    const retention = findRetentionCandidates(deps.db);
    const upgrade = findUpgradeSignals(deps.db);
    sendJson(ctx.res, 200, {
      duplicates,
      compaction,
      retention,
      upgrade,
      durationMs: Date.now() - start
    });
    void ctx;
  };

/**
 * POST /maintenance/cleanup-lint
 *
 * Auto-fix the lint categories with deterministic cleanup paths:
 * `orphan_embeddings` (rows in record_vec whose record_id no longer
 * exists in records), `orphan_doc_embeddings` (same in record_doc_vec),
 * and `temporal_future_clamps` (records with `created` or `updated`
 * stamps in the future, clamped to now). Categories that need human
 * review or are handled by other passes are reported under
 * `needsReview` with their current counts. Idempotent.
 *
 * Returns `{totalFixed, fixed: {orphan_embeddings, orphan_doc_embeddings,
 * temporal_future_clamps}, needsReview, durationMs}`.
 */
export const cleanupLintHandler =
  (deps: MaintenanceDeps): Handler =>
  ctx => {
    const summary = cleanupLint(deps.db);
    sendJson(ctx.res, 200, summary);
    void ctx;
  };

interface CleanupTagAliasesBody {
  aliases?: unknown;
}

/**
 * POST /maintenance/cleanup-tag-aliases  body: {aliases: string[]}
 *
 * Delete dangling `tag_aliases` rows by explicit name list. An alias is
 * dangling when its `canonical` is missing from `tags_taxonomy`. The
 * `aliases` argument is required — there is no "delete every dangling
 * row" mode, because the aliases were authored by a human and the
 * operator decides which to drop.
 *
 * Each input alias is sorted into one of three disjoint buckets:
 * `deleted` (DELETE applied), `missing` (alias not in `tag_aliases`),
 * `notDangling` (alias exists and its canonical exists too — would lose
 * intent). Idempotent: a second call with the same list returns all
 * aliases under `missing`.
 *
 * 400 on missing/invalid `aliases` body.
 */
export const cleanupTagAliasesHandler =
  (deps: MaintenanceDeps): Handler =>
  async ctx => {
    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }
    if (raw.trim().length === 0) {
      sendError(ctx.res, 400, 'bad_request', 'request body required');
      return;
    }
    let parsed: CleanupTagAliasesBody;
    try {
      const obj = JSON.parse(raw) as unknown;
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        sendError(ctx.res, 400, 'bad_request', 'request body must be a JSON object');
        return;
      }
      parsed = obj as CleanupTagAliasesBody;
    } catch (err) {
      sendError(ctx.res, 400, 'bad_request', `invalid JSON: ${(err as Error).message}`);
      return;
    }
    if (!Array.isArray(parsed.aliases)) {
      sendError(ctx.res, 400, 'bad_request', 'aliases must be an array of strings');
      return;
    }
    const aliases: string[] = [];
    for (const a of parsed.aliases) {
      if (typeof a !== 'string' || a.length === 0) {
        sendError(ctx.res, 400, 'bad_request', 'aliases must be non-empty strings');
        return;
      }
      aliases.push(a);
    }
    const summary = cleanupTagAliases(deps.db, aliases);
    sendJson(ctx.res, 200, summary);
  };

/**
 * POST /maintenance/embed-pending
 *
 * Re-embed records whose chunks are missing or whose stored content_hash
 * has drifted from the record's body. The watcher does this automatically
 * on file changes; this manual trigger covers the case where the watcher
 * was off, missed an event, or the embedder was unavailable when a record
 * first imported. Idempotent — a no-op when nothing's pending.
 *
 * Concurrent manual calls coalesce onto the same in-flight pass, so the
 * UI button can be mashed safely. The watcher pass remains independent;
 * a rare race could double-embed a record briefly, but the writes are
 * consistent (drift detection catches any TOCTOU on body change).
 */
let embedInFlight: Promise<EmbedSummary> | null = null;

export const embedPendingHandler =
  (deps: EmbedDeps): Handler =>
  async ctx => {
    if (!embedInFlight) {
      embedInFlight = embedPending(deps.db, deps.embedder).finally(() => {
        embedInFlight = null;
      });
    }
    const summary = await embedInFlight;
    sendJson(ctx.res, 200, summary);
  };

/**
 * GET /maintenance/raw-inbox
 *
 * Inspect the vault's `raw/` quick-capture inbox. Top-level `.md` files
 * (excluding `_about.md` and the `archive/` subfolder) are split into
 * ready (FM `ready: true`) and drafts (no flag). The dashboard uses this
 * to surface a "run /vault ingest" reminder when ready notes accumulate
 * — and to nudge the user when drafts are sitting around in case the
 * `ready` flip was forgotten.
 */
export const rawInboxHandler =
  (deps: SnapshotDeps): Handler =>
  ctx => {
    const summary = scanRawInbox(deps.vaultDataPath);
    sendJson(ctx.res, 200, summary);
    void ctx;
  };

/**
 * GET /maintenance/folder-listing?path=<folder>
 *
 * Direct children of a vault folder: subfolders (as strings) and files
 * (with FM-derived metadata). Empty path → vault root. Backs the browse
 * UI at /ui/folder.html. Sees only what the indexer knows about — i.e.,
 * the records table. Non-markdown attachments aren't visible.
 */
export const folderListingHandler =
  (deps: MaintenanceDeps): Handler =>
  ctx => {
    const path = ctx.query['path'] ?? '';
    const listing = listFolder(deps.db, path);
    sendJson(ctx.res, 200, listing);
  };

/**
 * GET /maintenance/snapshot-download?name=<filename>
 *
 * Stream a snapshot file from `<vaultDataPath>/.snapshots/<name>` as
 * `application/gzip`. The vault GET handler decodes file bodies as
 * UTF-8 (correct for markdown), which mangles binary; this endpoint
 * is the byte-faithful path for retrieving backups for offline
 * analysis. Hardened against path traversal.
 */
export const snapshotDownloadHandler =
  (deps: SnapshotDeps): Handler =>
  ctx => {
    const name = ctx.query['name'];
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
      sendError(ctx.res, 400, 'bad_request', 'name must be a bare filename under .snapshots/');
      return;
    }
    const abs = join(deps.vaultDataPath, '.snapshots', name);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      sendError(ctx.res, 404, 'not_found', 'snapshot not found');
      return;
    }
    if (!stat.isFile()) {
      sendError(ctx.res, 404, 'not_found', 'not a file');
      return;
    }
    ctx.res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Length': String(stat.size),
      'Content-Disposition': `attachment; filename="${name}"`
    });
    createReadStream(abs).pipe(ctx.res);
  };

export const snapshotHandler =
  (deps: SnapshotDeps): Handler =>
  async ctx => {
    const defaultPath = join(deps.vaultDataPath, '.snapshots', 'vault.sqlite.gz');
    const path = ctx.query['path'] ? join(deps.vaultDataPath, ctx.query['path']) : defaultPath;
    try {
      const result = await snapshotDb(deps.db, path);
      sendJson(ctx.res, 200, result);
    } catch (err) {
      sendError(
        ctx.res,
        500,
        'snapshot_failed',
        `snapshot failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

/**
 * GET /maintenance/snapshot-list
 *
 * List files directly under `<vaultDataPath>/.snapshots/`. Returns
 * `{snapshots: [{name, bytes, mtime}], totalBytes}` sorted by mtime
 * descending (newest first). Subdirectories are ignored. Empty
 * `.snapshots/` (or missing directory) returns an empty list.
 *
 * Pairs with `DELETE /maintenance/snapshot?name=…` to give host-cron
 * retention scripts a discoverable + deletable surface without
 * filesystem access — see `topics/host-cron-architecture-for-stateful-services`.
 */
export const snapshotListHandler =
  (deps: SnapshotDeps): Handler =>
  ctx => {
    const dir = join(deps.vaultDataPath, '.snapshots');
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch {
      sendJson(ctx.res, 200, {snapshots: [], totalBytes: 0});
      return;
    }
    const snapshots = entries
      .filter(e => e.isFile())
      .map(e => {
        const stat = statSync(join(dir, e.name));
        return {name: e.name, bytes: stat.size, mtime: stat.mtime.toISOString()};
      })
      .sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
    const totalBytes = snapshots.reduce((sum, s) => sum + s.bytes, 0);
    sendJson(ctx.res, 200, {snapshots, totalBytes});
  };

/**
 * DELETE /maintenance/snapshot?name=<filename>
 *
 * Remove a snapshot file from `<vaultDataPath>/.snapshots/<name>`.
 * Bare filenames only — no path separators, no traversal. 204 on
 * success; 400 on bad name; 404 if missing.
 *
 * The host-cron retention pattern: cron picks names from
 * `GET /maintenance/snapshot-list` by age + count threshold and
 * deletes them via this endpoint. Server provides the mechanic;
 * host orchestrates the policy.
 */
export const snapshotDeleteHandler =
  (deps: SnapshotDeps): Handler =>
  ctx => {
    const name = ctx.query['name'];
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
      sendError(ctx.res, 400, 'bad_request', 'name must be a bare filename under .snapshots/');
      return;
    }
    const abs = join(deps.vaultDataPath, '.snapshots', name);
    try {
      const stat = statSync(abs);
      if (!stat.isFile()) {
        sendError(ctx.res, 404, 'not_found', 'not a file');
        return;
      }
    } catch {
      sendError(ctx.res, 404, 'not_found', 'snapshot not found');
      return;
    }
    unlinkSync(abs);
    sendNoContent(ctx.res);
  };
