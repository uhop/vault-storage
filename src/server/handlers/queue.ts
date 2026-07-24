// HTTP handlers over the queue_items table. Six read endpoints + the explicit
// rebuild endpoint that walks the vault and re-parses every queue file.
//
// The table is rebuilt by the watcher on file changes; these handlers serve
// reads and surface the rebuild as a manual trigger for first-run population
// after the migration lands or when the watcher missed an event.

import type {DatabaseSync} from 'node:sqlite';
import {blockedView, readyView, type BlockerReport} from '../../queue/ready.ts';
import {QueueItemsRepository, type QueueItemRow} from '../../queue/repo.ts';
import {reindexAllQueues} from '../../queue/sync.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler, RequestContext} from '../router.ts';

interface QueueDeps {
  db: DatabaseSync;
}

interface ReindexDeps {
  db: DatabaseSync;
  vaultDataPath: string;
}

const toApi = (row: QueueItemRow): Record<string, unknown> => ({
  id: row.id,
  project: row.project,
  section: row.section,
  priority: row.priority,
  position: row.position,
  title: row.title,
  title_norm: row.title_norm,
  body: row.body,
  closed_at: row.closed_at,
  close_reason: row.close_reason,
  source_file: row.source_file,
  source_line: row.source_line,
  body_hash: row.body_hash,
  blocked_by: row.blocked_by,
  created_at: row.created_at,
  updated_at: row.updated_at
});

/**
 * Reject query keys outside `allowed` with a 400 naming the offender — a
 * typo'd filter must fail loud, not fall through to an unfiltered answer
 * (the `GET /sections` `?path=` incident, applied from birth here).
 * Returns true when the query is clean.
 */
const rejectUnknownParams = (ctx: RequestContext, allowed: ReadonlySet<string>): boolean => {
  const unknown = Object.keys(ctx.query).filter(k => !allowed.has(k));
  if (unknown.length === 0) return true;
  sendError(
    ctx.res,
    400,
    'bad_request',
    `unknown query parameter(s): ${unknown.join(', ')} — supported: ${[...allowed].sort().join(', ') || '(none)'}`
  );
  return false;
};

const parsePositiveInt = (raw: string | undefined, fallback: number): number | null => {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
};

const parseSignedInt = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) return null;
  return n;
};

/**
 * GET /queue/top?limit=N
 *
 * Top N open items across the fleet, ordered by `(priority DESC, project,
 * section, position)`. Excludes archive. Default limit 20, max 100.
 *
 * Use case: "what's next across all projects?" Backs the dashboard's fleet
 * priority view.
 */
export const queueTopHandler =
  (deps: QueueDeps): Handler =>
  ctx => {
    const limit = parsePositiveInt(ctx.query['limit'], 20);
    if (limit === null) {
      sendError(ctx.res, 400, 'bad_request', 'limit must be a positive integer');
      return;
    }
    const capped = Math.min(limit, 100);
    const repo = new QueueItemsRepository(deps.db);
    const items = repo.listTopOpen(capped).map(toApi);
    sendJson(ctx.res, 200, {limit: capped, count: items.length, items});
  };

/**
 * GET /queue/by-section/{section}
 *
 * Fleet-wide for one open section. `{section}` must be `active`, `backlog`,
 * or `watching`. Items are ordered by `(priority DESC, project, position)`.
 */
export const queueBySectionHandler =
  (deps: QueueDeps): Handler =>
  ctx => {
    const section = ctx.params['section'];
    if (section !== 'active' && section !== 'backlog' && section !== 'watching') {
      sendError(ctx.res, 400, 'bad_request', 'section must be one of: active, backlog, watching');
      return;
    }
    const repo = new QueueItemsRepository(deps.db);
    const items = repo.listBySection(section).map(toApi);
    sendJson(ctx.res, 200, {section, count: items.length, items});
  };

/**
 * GET /queue/by-priority/{n}
 *
 * Fleet-wide for one priority tier in Backlog. `{n}` is a signed integer.
 * Items are ordered by `(project, position)`.
 */
export const queueByPriorityHandler =
  (deps: QueueDeps): Handler =>
  ctx => {
    const priority = parseSignedInt(ctx.params['n']);
    if (priority === null) {
      sendError(ctx.res, 400, 'bad_request', 'priority must be a signed integer');
      return;
    }
    const repo = new QueueItemsRepository(deps.db);
    const items = repo.listByPriority(priority).map(toApi);
    sendJson(ctx.res, 200, {priority, count: items.length, items});
  };

/**
 * GET /queue/projects/{name}
 *
 * All open items (Active + Backlog + Watching) for one project, grouped
 * by section, ordered by `(section_rank, priority DESC, position)` —
 * Active first, then Backlog by priority, then Watching.
 */
export const queueByProjectHandler =
  (deps: QueueDeps): Handler =>
  ctx => {
    const project = ctx.params['name'];
    if (!project) {
      sendError(ctx.res, 400, 'bad_request', 'missing project name');
      return;
    }
    const repo = new QueueItemsRepository(deps.db);
    const items = repo.listOpenByProject(project).map(toApi);
    sendJson(ctx.res, 200, {project, count: items.length, items});
  };

/**
 * GET /queue/projects/{name}/archive
 *
 * Archive slice for one project, ordered by `closed_at DESC` with undated
 * rows last. Used for project-history surfaces (UI archive view, audit
 * queries).
 */
export const queueArchiveByProjectHandler =
  (deps: QueueDeps): Handler =>
  ctx => {
    const project = ctx.params['name'];
    if (!project) {
      sendError(ctx.res, 400, 'bad_request', 'missing project name');
      return;
    }
    const repo = new QueueItemsRepository(deps.db);
    const items = repo.listArchiveByProject(project).map(toApi);
    sendJson(ctx.res, 200, {project, count: items.length, items});
  };

const blockerReportToApi = (report: BlockerReport): Record<string, unknown> => ({
  ...toApi(report.item),
  blockers: report.blockers.map(b => ({
    ref: b.ref,
    state: b.state,
    ...(b.target ? {target: b.target} : {}),
    ...(b.matches !== undefined ? {matches: b.matches} : {})
  })),
  in_cycle: report.inCycle
});

/**
 * GET /queue/ready[?project=<name>]
 *
 * Backlog items whose `blocked-by:` refs (if any) all resolve to archived
 * items — the "claimable next" view, ordered `(priority DESC, project,
 * position)`. Active is already started and Watching is upstream-gated, so
 * neither appears. Unresolved and ambiguous refs BLOCK (they surface in
 * `/queue/blocked` with detail); refs resolve at query time against the
 * whole table, so cross-project blockers and archive closure are always
 * current. Unknown query parameters are a 400, not a silent no-op.
 */
export const queueReadyHandler =
  (deps: QueueDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, new Set(['project']))) return;
    const project = ctx.query['project'];
    const repo = new QueueItemsRepository(deps.db);
    const universe = repo.listAll();
    const candidates = project ? universe.filter(row => row.project === project) : universe;
    const items = readyView(candidates, universe).map(toApi);
    sendJson(ctx.res, 200, {
      ...(project ? {project} : {}),
      count: items.length,
      items
    });
  };

/**
 * GET /queue/blocked[?project=<name>]
 *
 * Open items (any open section) with at least one blocking ref, each with
 * per-ref resolution detail (`state`: open | unresolved | ambiguous, plus
 * the resolved target when there is one) and an `in_cycle` flag — mutually
 * blocked items can never self-release, so cycles are surfaced as data
 * bugs. The complementary view to `/queue/ready`.
 */
export const queueBlockedHandler =
  (deps: QueueDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, new Set(['project']))) return;
    const project = ctx.query['project'];
    const repo = new QueueItemsRepository(deps.db);
    const universe = repo.listAll();
    const candidates = project ? universe.filter(row => row.project === project) : universe;
    const items = blockedView(candidates, universe).map(blockerReportToApi);
    sendJson(ctx.res, 200, {
      ...(project ? {project} : {}),
      count: items.length,
      items
    });
  };

/**
 * POST /maintenance/reindex-queues
 *
 * Walk the vault, re-parse every `projects/<name>/queue.md` and
 * `queue-archive.md`, and apply each as a slice. Additionally drops DB
 * slices for files no longer on disk. The watcher already keeps the
 * table in sync on edits; use this endpoint for first-run population
 * after migration 0008 lands, or to recover from a missed-event window.
 *
 * Returns `{projectsScanned, filesProcessed, inserted, updated, refreshed,
 * deleted, staleSlicesDropped, errors, durationMs}`.
 */
export const reindexQueuesHandler =
  (deps: ReindexDeps): Handler =>
  ctx => {
    const repo = new QueueItemsRepository(deps.db);
    const summary = reindexAllQueues(repo, deps.vaultDataPath);
    sendJson(ctx.res, 200, summary);
  };
