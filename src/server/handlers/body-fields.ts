import type {DatabaseSync} from 'node:sqlite';
import {bodyFieldReport} from '../body-fields.ts';
import {NO_QUERY_PARAMS, rejectUnknownParams} from '../query.ts';
import {sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

/**
 * GET /system/body-fields — per write route, the JSON requests seen by client
 * and the top-level fields sent that the route does not read (D64):
 * `{since, routes: [{route, requests, clients, unknown}]}`.
 */
export const bodyFieldsHandler =
  (deps: {db: DatabaseSync}): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    sendJson(ctx.res, 200, bodyFieldReport(deps.db));
  };
