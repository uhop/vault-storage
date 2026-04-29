import type {DatabaseSync} from 'node:sqlite';
import {RecordVecRepository} from '../../db/vec-repo.ts';
import {RecordsRepository} from '../../records/repository.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';
import {toJsonRecord} from '../serialize.ts';

interface SimilarDeps {
  db: DatabaseSync;
}

/**
 * GET /sections/{id}/similar?k=10
 * Embedding-based nearest neighbors. Aggregates across all of the record's
 * chunks, excludes the record itself, returns up to k matches.
 */
export const similarHandler =
  (deps: SimilarDeps): Handler =>
  ctx => {
    const id = ctx.params['id'];
    if (!id) {
      sendError(ctx.res, 400, 'bad_request', 'missing record_id');
      return;
    }

    const records = new RecordsRepository(deps.db);
    const root = records.getById(id);
    if (!root) {
      sendError(ctx.res, 404, 'record_not_found', `no record with id ${id}`);
      return;
    }

    const kRaw = ctx.query['k'];
    let k = kRaw === undefined ? 10 : Number.parseInt(kRaw, 10);
    if (!Number.isFinite(k) || k < 1) {
      sendError(ctx.res, 400, 'bad_request', `k must be a positive integer (got ${kRaw})`);
      return;
    }
    if (k > 100) k = 100;

    const vec = new RecordVecRepository(deps.db);
    const hits = vec.nearestToRecord(id, k);

    const items = hits
      .map(h => {
        const r = records.getById(h.recordId);
        if (!r) return null;
        return {
          ...toJsonRecord(r, {includeBody: false}),
          distance: h.distance,
          score: Number((1 - h.distance / 2).toFixed(4))
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    sendJson(ctx.res, 200, {root_id: id, k, items});
  };
