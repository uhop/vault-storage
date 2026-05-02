import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {cleanupLint} from '../../maintenance/cleanup-lint.ts';
import {findCompactionCandidates} from '../../maintenance/find-compaction-candidates.ts';
import {findDuplicates} from '../../maintenance/find-duplicates.ts';
import {findRetentionCandidates} from '../../maintenance/find-retention-candidates.ts';
import {findUpgradeSignals} from '../../maintenance/find-upgrade-signals.ts';
import {
  clearLastIndexedCommit,
  incrementalReindex
} from '../../maintenance/incremental-reindex.ts';
import {snapshotDb} from '../snapshot.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

interface MaintenanceDeps {
  db: DatabaseSync;
}

interface SnapshotDeps {
  db: DatabaseSync;
  vaultDataPath: string;
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
 * Auto-fix the lint categories with deterministic cleanup paths
 * (currently only `orphan_embeddings`: rows in record_vec whose
 * record_id no longer exists in records). Categories that need human
 * review or are handled by other passes are reported under
 * `needsReview` with their current counts. Idempotent.
 *
 * Returns `{totalFixed, fixed: {orphan_embeddings: {recordsAffected,
 * chunksDeleted}}, needsReview, durationMs}`.
 */
export const cleanupLintHandler =
  (deps: MaintenanceDeps): Handler =>
  ctx => {
    const summary = cleanupLint(deps.db);
    sendJson(ctx.res, 200, summary);
    void ctx;
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
