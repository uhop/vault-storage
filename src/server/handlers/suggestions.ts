import type {DatabaseSync} from 'node:sqlite';
import {uuidv7} from '../../util/uuid.ts';
import {readBodyText} from '../body.ts';
import {parsePagination, splitCsv} from '../query.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

interface SuggestionsDeps {
  db: DatabaseSync;
}

const SUGGESTION_KINDS: ReadonlySet<string> = new Set([
  'edge_type',
  'duplicate',
  'archive_candidate',
  'merge_candidate',
  'compaction_candidate',
  'contradiction_candidate',
  'tag_suggestion',
  'new_tag',
  'inefficiency_detected',
  'infrastructure_upgrade',
  'frontmatter_inference_ambiguous',
  'agent_enrichment_stale'
]);
const SUGGESTION_STATUSES: ReadonlySet<string> = new Set(['pending', 'accepted', 'rejected']);

interface SuggestionRow {
  id: string;
  kind: string;
  subject_id: string | null;
  payload: string;
  status: string;
  created: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

const rowToJson = (row: SuggestionRow): Record<string, unknown> => {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = {raw: row.payload};
  }
  return {
    id: row.id,
    kind: row.kind,
    subject_id: row.subject_id,
    status: row.status,
    payload,
    created: row.created,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by
  };
};

/**
 * GET /suggestions?kind=&status=&subject_id=&offset=&limit=
 * Defaults to status=pending when no status filter is given — the most
 * common agent-review query.
 */
export const listSuggestionsHandler =
  (deps: SuggestionsDeps): Handler =>
  ctx => {
    const kinds = splitCsv(ctx.query['kind']);
    for (const k of kinds) {
      if (!SUGGESTION_KINDS.has(k)) {
        sendError(ctx.res, 400, 'bad_request', `unknown suggestion kind: ${k}`);
        return;
      }
    }
    const statusesRaw = splitCsv(ctx.query['status']);
    const statuses = statusesRaw.length > 0 ? statusesRaw : ['pending'];
    for (const s of statuses) {
      if (!SUGGESTION_STATUSES.has(s)) {
        sendError(ctx.res, 400, 'bad_request', `unknown suggestion status: ${s}`);
        return;
      }
    }

    const subjectId = ctx.query['subject_id'];
    const {offset, limit} = parsePagination(ctx.query);

    const where: string[] = [];
    const bindings: string[] = [];
    if (kinds.length > 0) {
      where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
      bindings.push(...kinds);
    }
    if (statuses.length > 0) {
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      bindings.push(...statuses);
    }
    if (subjectId !== undefined && subjectId.length > 0) {
      where.push('subject_id = ?');
      bindings.push(subjectId);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const rows = deps.db
      .prepare(
        `SELECT id, kind, subject_id, payload, status, created, resolved_at, resolved_by
           FROM suggestions
           ${whereClause}
           ORDER BY created DESC
           LIMIT ? OFFSET ?`
      )
      .all(...bindings, limit, offset) as unknown[] as SuggestionRow[];

    const total = (
      deps.db.prepare(`SELECT COUNT(*) AS n FROM suggestions ${whereClause}`).get(...bindings) as {
        n: number;
      }
    ).n;

    sendJson(ctx.res, 200, {
      items: rows.map(rowToJson),
      offset,
      limit,
      total
    });
  };

/**
 * GET /suggestions/summary?status=pending
 *
 * Per-kind counts of suggestions in the requested status set (default
 * `pending`). Surfaced at session start by `/vault resume` so the agent
 * sees the review backlog at a glance — cheaper than `?limit=…` round-trips
 * per kind.
 */
export const summarySuggestionsHandler =
  (deps: SuggestionsDeps): Handler =>
  ctx => {
    const statusesRaw = splitCsv(ctx.query['status']);
    const statuses = statusesRaw.length > 0 ? statusesRaw : ['pending'];
    for (const s of statuses) {
      if (!SUGGESTION_STATUSES.has(s)) {
        sendError(ctx.res, 400, 'bad_request', `unknown suggestion status: ${s}`);
        return;
      }
    }

    const rows = deps.db
      .prepare(
        `SELECT kind, COUNT(*) AS n
           FROM suggestions
           WHERE status IN (${statuses.map(() => '?').join(',')})
           GROUP BY kind
           ORDER BY n DESC, kind ASC`
      )
      .all(...statuses) as Array<{kind: string; n: number}>;

    const byKind: Record<string, number> = {};
    let total = 0;
    for (const r of rows) {
      byKind[r.kind] = r.n;
      total += r.n;
    }

    sendJson(ctx.res, 200, {
      statuses,
      total,
      by_kind: byKind
    });
  };

/** GET /suggestions/{id} — single suggestion. */
export const getSuggestionHandler =
  (deps: SuggestionsDeps): Handler =>
  ctx => {
    const id = ctx.params['id'];
    if (!id) {
      sendError(ctx.res, 400, 'bad_request', 'missing suggestion id');
      return;
    }
    const row = deps.db
      .prepare(
        `SELECT id, kind, subject_id, payload, status, created, resolved_at, resolved_by
           FROM suggestions WHERE id = ?`
      )
      .get(id) as SuggestionRow | undefined;
    if (!row) {
      sendError(ctx.res, 404, 'suggestion_not_found', `no suggestion with id ${id}`);
      return;
    }
    sendJson(ctx.res, 200, rowToJson(row));
  };

interface ResolveBody {
  resolved_by?: string;
}

const parseResolveBody = async (raw: string): Promise<ResolveBody | string> => {
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'request body must be a JSON object';
    }
    return parsed as ResolveBody;
  } catch (err) {
    return `invalid JSON: ${(err as Error).message}`;
  }
};

const makeResolveHandler =
  (deps: SuggestionsDeps, target: 'accepted' | 'rejected'): Handler =>
  async ctx => {
    const id = ctx.params['id'];
    if (!id) {
      sendError(ctx.res, 400, 'bad_request', 'missing suggestion id');
      return;
    }

    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }
    const body = await parseResolveBody(raw);
    if (typeof body === 'string') {
      sendError(ctx.res, 400, 'bad_request', body);
      return;
    }

    const existing = deps.db.prepare('SELECT id, status FROM suggestions WHERE id = ?').get(id) as
      | {id: string; status: string}
      | undefined;
    if (!existing) {
      sendError(ctx.res, 404, 'suggestion_not_found', `no suggestion with id ${id}`);
      return;
    }
    if (existing.status !== 'pending') {
      sendError(
        ctx.res,
        409,
        'already_resolved',
        `suggestion is already ${existing.status}; resolutions are not undoable`
      );
      return;
    }

    const now = new Date().toISOString();
    deps.db
      .prepare(
        `UPDATE suggestions SET status = ?, resolved_at = ?, resolved_by = ?
          WHERE id = ?`
      )
      .run(target, now, body.resolved_by ?? null, id);

    const updated = deps.db
      .prepare(
        `SELECT id, kind, subject_id, payload, status, created, resolved_at, resolved_by
           FROM suggestions WHERE id = ?`
      )
      .get(id) as unknown as SuggestionRow;
    sendJson(ctx.res, 200, rowToJson(updated));
  };

/** POST /suggestions/{id}/accept — mark accepted. Side-effects (e.g.,
 *  promoting cites→typed) are deferred to agent skills. */
export const acceptSuggestionHandler = (deps: SuggestionsDeps): Handler =>
  makeResolveHandler(deps, 'accepted');

/** POST /suggestions/{id}/reject — mark rejected. */
export const rejectSuggestionHandler = (deps: SuggestionsDeps): Handler =>
  makeResolveHandler(deps, 'rejected');

interface CreateBody {
  kind?: unknown;
  subject_id?: unknown;
  payload?: unknown;
}

/**
 * POST /suggestions
 *
 * File a new pending suggestion from the agent side. Used for kinds the
 * indexer can't deterministically detect — `contradiction_candidate`,
 * `tag_suggestion` (agent-judged additions), future agent-driven kinds.
 * Indexer-driven filers (`edge_type`, `new_tag`, `duplicate`,
 * `agent_enrichment_stale`) live behind their own idempotency keys; this
 * handler does no dedup, so agents calling repeatedly produce repeated
 * suggestions. Caller is responsible for any pre-check via GET /suggestions.
 *
 * Body: `{kind: string, subject_id?: string|null, payload: object}`.
 * `kind` must be in the closed enum. `payload` is stored as JSON; arbitrary
 * shape is up to the kind's convention.
 *
 * Returns 201 with the created row (same shape as GET /suggestions/{id}).
 */
export const createSuggestionHandler =
  (deps: SuggestionsDeps): Handler =>
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

    let body: CreateBody;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendError(ctx.res, 400, 'bad_request', 'request body must be a JSON object');
        return;
      }
      body = parsed as CreateBody;
    } catch (err) {
      sendError(ctx.res, 400, 'bad_request', `invalid JSON: ${(err as Error).message}`);
      return;
    }

    if (typeof body.kind !== 'string' || !SUGGESTION_KINDS.has(body.kind)) {
      sendError(
        ctx.res,
        400,
        'bad_request',
        `kind must be one of: ${[...SUGGESTION_KINDS].join(', ')}`
      );
      return;
    }
    if (
      body.payload === undefined ||
      body.payload === null ||
      typeof body.payload !== 'object' ||
      Array.isArray(body.payload)
    ) {
      sendError(ctx.res, 400, 'bad_request', 'payload must be a JSON object');
      return;
    }
    let subjectId: string | null = null;
    if (body.subject_id !== undefined && body.subject_id !== null) {
      if (typeof body.subject_id !== 'string' || body.subject_id.length === 0) {
        sendError(ctx.res, 400, 'bad_request', 'subject_id must be a non-empty string when set');
        return;
      }
      subjectId = body.subject_id;
    }

    const id = uuidv7();
    const now = new Date().toISOString();
    deps.db
      .prepare(
        `INSERT INTO suggestions (id, kind, subject_id, payload, status, created)
         VALUES (?, ?, ?, ?, 'pending', ?)`
      )
      .run(id, body.kind, subjectId, JSON.stringify(body.payload), now);

    const row = deps.db
      .prepare(
        `SELECT id, kind, subject_id, payload, status, created, resolved_at, resolved_by
           FROM suggestions WHERE id = ?`
      )
      .get(id) as unknown as SuggestionRow;
    sendJson(ctx.res, 201, rowToJson(row));
  };

/**
 * POST /suggestions/{id}/reopen
 *
 * Move an accepted or rejected suggestion back to `pending` and clear
 * `resolved_at` + `resolved_by`. Escape hatch for misclicks. 409 when the
 * suggestion is already pending; 404 when unknown.
 */
export const reopenSuggestionHandler =
  (deps: SuggestionsDeps): Handler =>
  ctx => {
    const id = ctx.params['id'];
    if (!id) {
      sendError(ctx.res, 400, 'bad_request', 'missing suggestion id');
      return;
    }
    const existing = deps.db.prepare('SELECT id, status FROM suggestions WHERE id = ?').get(id) as
      | {id: string; status: string}
      | undefined;
    if (!existing) {
      sendError(ctx.res, 404, 'suggestion_not_found', `no suggestion with id ${id}`);
      return;
    }
    if (existing.status === 'pending') {
      sendError(ctx.res, 409, 'already_pending', 'suggestion is already pending');
      return;
    }
    deps.db
      .prepare(
        `UPDATE suggestions SET status = 'pending', resolved_at = NULL, resolved_by = NULL
          WHERE id = ?`
      )
      .run(id);
    const row = deps.db
      .prepare(
        `SELECT id, kind, subject_id, payload, status, created, resolved_at, resolved_by
           FROM suggestions WHERE id = ?`
      )
      .get(id) as unknown as SuggestionRow;
    sendJson(ctx.res, 200, rowToJson(row));
  };
