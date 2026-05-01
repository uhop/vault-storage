import type {DatabaseSync} from 'node:sqlite';
import {findCompactionCandidates} from '../../maintenance/find-compaction-candidates.ts';
import {findDuplicates} from '../../maintenance/find-duplicates.ts';
import {findRetentionCandidates} from '../../maintenance/find-retention-candidates.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

interface MaintenanceDeps {
  db: DatabaseSync;
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
