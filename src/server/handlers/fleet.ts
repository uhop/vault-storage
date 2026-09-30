import type {DatabaseSync} from 'node:sqlite';
import {FleetStateRepository, type FleetRun} from '../../fleet/state.ts';
import {asOf} from '../as-of.ts';
import {rejectUnknownParams} from '../query.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

interface FleetDeps {
  db: DatabaseSync;
}

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const DEFAULT_RUNS = 30;

/** An ISO time, or `Nd` for N days back; null when neither. */
export const parseSince = (raw: string, now = Date.now()): string | null => {
  const days = /^(\d+)d$/.exec(raw);
  if (days) return new Date(now - Number(days[1]) * 864e5).toISOString();
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** The run with only the named project's repository entries; null when it has none. */
const narrowRun = (run: FleetRun, project: string): FleetRun | null => {
  const repos = (run.repos ?? []).filter(r => r.project === project);
  return repos.length === 0 ? null : {...run, repos};
};

/**
 * GET /fleet/status[?project=<name>][&since=<iso|Nd>][&runs=<n>]
 *
 * The stored fleet-status data in one read (D110): `baselines`, one per
 * `projects/<name>/state.md` with its `github` and `packages` blocks, and
 * `runs`, the digest note's runs newest first. `project` narrows the
 * baselines to one and each run's `repos` to that project, dropping runs
 * with nothing of it; `since` bounds the runs by `collected_at`; `runs`
 * caps their number (default 30, the digest's own cap; 0 leaves them out).
 */
export const fleetStatusHandler =
  (deps: FleetDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, new Set(['project', 'since', 'runs']))) return;
    const project = ctx.query['project'];
    if (project !== undefined && !PROJECT_NAME_RE.test(project)) {
      sendError(ctx.res, 400, 'bad_request', 'project must be a kebab-case name');
      return;
    }
    const sinceRaw = ctx.query['since'];
    const since = sinceRaw === undefined ? '' : parseSince(sinceRaw);
    if (since === null) {
      sendError(ctx.res, 400, 'bad_request', 'since must be an ISO time or <N>d');
      return;
    }
    const runsRaw = ctx.query['runs'];
    const limit = runsRaw === undefined ? DEFAULT_RUNS : Number(runsRaw);
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
      sendError(ctx.res, 400, 'bad_request', 'runs must be an integer from 0 to 1000');
      return;
    }
    const repo = new FleetStateRepository(deps.db);
    const baselines = repo.baselines(project);
    let runs: FleetRun[] = [];
    if (limit > 0) {
      runs =
        project === undefined
          ? repo.runs(since, limit)
          : // Every stored run is read when narrowing, since the cap counts
            // the runs that mention the project, not the runs stored.
            repo
              .runs(since, 1000)
              .map(run => narrowRun(run, project))
              .filter((run): run is FleetRun => run !== null)
              .slice(0, limit);
    }
    sendJson(ctx.res, 200, {
      ...(project === undefined ? {} : {project}),
      baselines,
      runs,
      as_of: asOf(deps.db)
    });
  };
