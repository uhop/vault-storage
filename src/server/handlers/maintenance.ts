import type {DatabaseSync} from 'node:sqlite';
import {findDuplicates} from '../../maintenance/find-duplicates.ts';
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

    const summary = findDuplicates(deps.db, {maxDistance, perRecord, limit});
    sendJson(ctx.res, 200, summary);
  };
