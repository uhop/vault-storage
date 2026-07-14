import type {DatabaseSync} from 'node:sqlite';
import {revertExpiredClaims} from '../../records/claims.ts';
import {EDGE_TYPES} from '../../records/types.ts';
import {uuidv7} from '../../util/uuid.ts';
import {readBodyText} from '../body.ts';
import {parsePagination, splitCsv} from '../query.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';
import {
  addTagToRecord,
  applyEdgeOverride,
  EffectError,
  stripSuggestedTag,
  type EffectDeps
} from '../suggestion-effects.ts';
import {WriterError} from '../writer.ts';

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
const SUGGESTION_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'claimed',
  'accepted',
  'rejected'
]);

interface SuggestionRow {
  id: string;
  kind: string;
  subject_id: string | null;
  payload: string;
  status: string;
  created: string;
  resolved_at: string | null;
  resolved_by: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  claim_expires: string | null;
}

const ROW_COLUMNS =
  'id, kind, subject_id, payload, status, created, resolved_at, resolved_by, claimed_by, claimed_at, claim_expires';

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
    resolved_by: row.resolved_by,
    claimed_by: row.claimed_by,
    claimed_at: row.claimed_at,
    claim_expires: row.claim_expires
  };
};

// Payload fields that reference records, per kind — the ids whose briefs
// `expand=context` inlines. `subject_id` is always included when set.
const CONTEXT_RECORD_KEYS: Record<string, readonly string[]> = {
  edge_type: ['from_record', 'to_record'],
  duplicate: ['a_record', 'b_record'],
  new_tag: ['record_id'],
  tag_suggestion: ['record_id'],
  archive_candidate: ['record_id'],
  agent_enrichment_stale: ['record_id']
};
const CONTEXT_TAG_KINDS: ReadonlySet<string> = new Set(['new_tag', 'tag_suggestion']);

const itemRecordIds = (item: Record<string, unknown>): Set<string> => {
  const payload = item['payload'] as Record<string, unknown> | null;
  const ids = new Set<string>();
  for (const key of CONTEXT_RECORD_KEYS[item['kind'] as string] ?? []) {
    const v = payload?.[key];
    if (typeof v === 'string' && v.length > 0) ids.add(v);
  }
  const subject = item['subject_id'];
  if (typeof subject === 'string' && subject.length > 0) ids.add(subject);
  return ids;
};

/**
 * Inline per-item triage context: record briefs (title/type/status/summary)
 * for every record the payload references — keyed by record_id, `null` for
 * records that no longer exist — plus taxonomy info for the tag kinds. One
 * batched record query per page; triage agents judge a prefetched page
 * instead of chasing per-item fetch chains.
 */
const attachContext = (db: DatabaseSync, items: Array<Record<string, unknown>>): void => {
  const recordIds = new Set<string>();
  const tags = new Set<string>();
  for (const item of items) {
    for (const id of itemRecordIds(item)) recordIds.add(id);
    if (CONTEXT_TAG_KINDS.has(item['kind'] as string)) {
      const tag = (item['payload'] as Record<string, unknown> | null)?.['tag'];
      if (typeof tag === 'string' && tag.length > 0) tags.add(tag);
    }
  }

  const briefs = new Map<string, unknown>();
  if (recordIds.size > 0) {
    const ids = [...recordIds];
    const rows = db
      .prepare(
        `SELECT record_id, file_path, title, type, status, updated, agent_summary
           FROM records WHERE record_id IN (${ids.map(() => '?').join(',')})`
      )
      .all(...ids) as unknown[] as Array<{
      record_id: string;
      file_path: string;
      title: string | null;
      type: string;
      status: string;
      updated: string;
      agent_summary: string | null;
    }>;
    for (const r of rows) {
      briefs.set(r.record_id, {
        record_id: r.record_id,
        file_path: r.file_path,
        title: r.title,
        type: r.type,
        status: r.status,
        updated: r.updated,
        summary: r.agent_summary
      });
    }
  }

  const tagInfo = new Map<string, unknown>();
  for (const t of tags) {
    const aliasRow = db.prepare('SELECT canonical FROM tag_aliases WHERE alias = ?').get(t) as
      {canonical: string} | undefined;
    const canonical = aliasRow?.canonical ?? t;
    const tax = db
      .prepare('SELECT tag, description FROM tags_taxonomy WHERE tag = ?')
      .get(canonical) as {tag: string; description: string | null} | undefined;
    const count = tax
      ? (db.prepare('SELECT COUNT(*) AS n FROM tags WHERE tag = ?').get(canonical) as {n: number}).n
      : 0;
    tagInfo.set(t, {
      requested: t,
      ...(canonical !== t ? {canonical} : {}),
      in_taxonomy: tax !== undefined,
      description: tax?.description ?? null,
      record_count: count
    });
  }

  for (const item of items) {
    const records: Record<string, unknown> = {};
    for (const id of itemRecordIds(item)) records[id] = briefs.get(id) ?? null;
    const context: Record<string, unknown> = {records};
    if (CONTEXT_TAG_KINDS.has(item['kind'] as string)) {
      const tag = (item['payload'] as Record<string, unknown> | null)?.['tag'];
      if (typeof tag === 'string' && tagInfo.has(tag)) context['tag'] = tagInfo.get(tag);
    }
    item['context'] = context;
  }
};

/**
 * GET /suggestions?kind=&status=&subject_id=&offset=&limit=&expand=context
 * Defaults to status=pending when no status filter is given — the most
 * common agent-review query. `expand=context` inlines per-item record
 * briefs + tag taxonomy info (see {@link attachContext}).
 */
export const listSuggestionsHandler =
  (deps: SuggestionsDeps): Handler =>
  ctx => {
    const expand = ctx.query['expand'];
    if (expand !== undefined && expand !== 'context') {
      sendError(ctx.res, 400, 'bad_request', `unknown expand: ${expand} (expected: context)`);
      return;
    }
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

    revertExpiredClaims(deps.db);
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
        `SELECT ${ROW_COLUMNS}
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

    const items = rows.map(rowToJson);
    if (expand === 'context') attachContext(deps.db, items);

    sendJson(ctx.res, 200, {
      items,
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

    revertExpiredClaims(deps.db);
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
    revertExpiredClaims(deps.db);
    const row = deps.db.prepare(`SELECT ${ROW_COLUMNS} FROM suggestions WHERE id = ?`).get(id) as
      SuggestionRow | undefined;
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

interface ResolvableRow {
  status: string;
  claimed_by: string | null;
  claim_expires: string | null;
}

/**
 * Whether `resolvedBy` may resolve this row. `null` = allowed; otherwise the
 * 409 to report. A live claim (expiry already handled by
 * `revertExpiredClaims`) is resolvable only by its holder — the caller's
 * `resolved_by` doubles as the holder identity.
 */
const claimConflict = (
  row: ResolvableRow,
  resolvedBy: string | null
): {code: string; message: string; details?: Record<string, unknown>} | null => {
  if (row.status === 'pending') return null;
  if (row.status === 'claimed') {
    if (resolvedBy !== null && resolvedBy === row.claimed_by) return null;
    return {
      code: 'claimed_by_other',
      message: `suggestion is claimed by "${row.claimed_by}" until ${row.claim_expires} — pass resolved_by matching the holder, or wait for the claim to expire`,
      details: {claimed_by: row.claimed_by, claim_expires: row.claim_expires}
    };
  }
  return {
    code: 'already_resolved',
    message: `suggestion is already ${row.status}; resolutions are not undoable`
  };
};

/**
 * Flip an unresolved (pending/claimed) row, clearing any claim. Guarded on
 * status so a resolution-on-contact settle that raced ahead (e.g. a
 * tag-realized auto-accept during a side-effect re-import) is never
 * overwritten. Returns false when the guard skipped the write.
 */
const flipStatus = (
  db: DatabaseSync,
  id: string,
  target: 'accepted' | 'rejected',
  resolvedBy: string | null,
  now: string
): boolean =>
  db
    .prepare(
      `UPDATE suggestions
          SET status = ?, resolved_at = ?, resolved_by = ?,
              claimed_by = NULL, claimed_at = NULL, claim_expires = NULL
        WHERE id = ? AND status IN ('pending', 'claimed')`
    )
    .run(target, now, resolvedBy, id).changes > 0;

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

    revertExpiredClaims(deps.db);
    const existing = deps.db
      .prepare('SELECT status, claimed_by, claim_expires FROM suggestions WHERE id = ?')
      .get(id) as ResolvableRow | undefined;
    if (!existing) {
      sendError(ctx.res, 404, 'suggestion_not_found', `no suggestion with id ${id}`);
      return;
    }
    const conflict = claimConflict(existing, body.resolved_by ?? null);
    if (conflict) {
      sendError(ctx.res, 409, conflict.code, conflict.message, conflict.details);
      return;
    }

    flipStatus(deps.db, id, target, body.resolved_by ?? null, new Date().toISOString());

    const updated = deps.db
      .prepare(`SELECT ${ROW_COLUMNS} FROM suggestions WHERE id = ?`)
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
      .prepare(`SELECT ${ROW_COLUMNS} FROM suggestions WHERE id = ?`)
      .get(id) as unknown as SuggestionRow;
    sendJson(ctx.res, 201, rowToJson(row));
  };

/**
 * POST /suggestions/{id}/reopen
 *
 * Move an accepted, rejected, or claimed suggestion back to `pending`,
 * clearing `resolved_at`/`resolved_by` and any claim. Escape hatch for
 * misclicks; on a claimed row it is the explicit claim release (the
 * alternative is waiting out the TTL). 409 when the suggestion is already
 * pending; 404 when unknown.
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
      {id: string; status: string} | undefined;
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
        `UPDATE suggestions
            SET status = 'pending', resolved_at = NULL, resolved_by = NULL,
                claimed_by = NULL, claimed_at = NULL, claim_expires = NULL
          WHERE id = ?`
      )
      .run(id);
    const row = deps.db
      .prepare(`SELECT ${ROW_COLUMNS} FROM suggestions WHERE id = ?`)
      .get(id) as unknown as SuggestionRow;
    sendJson(ctx.res, 200, rowToJson(row));
  };

const CLAIM_LIMIT_DEFAULT = 100;
const CLAIM_LIMIT_MAX = 100;
const CLAIM_TTL_DEFAULT_S = 1800;
const CLAIM_TTL_MIN_S = 60;
const CLAIM_TTL_MAX_S = 21600;

const intField = (
  value: unknown,
  name: string,
  def: number,
  min: number,
  max: number
): number | string => {
  if (value === undefined || value === null) return def;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return `${name} must be an integer`;
  }
  if (value < min || value > max) return `${name} must be in [${min}, ${max}]`;
  return value;
};

/**
 * POST /suggestions/claim — atomically reserve a batch of pending
 * suggestions for one triage session, oldest first.
 *
 * Body: `{kind: string, holder: string, limit?: number, ttl_seconds?: number}`.
 * The batch flips `pending → claimed` stamped with the holder and an expiry;
 * until then only a resolver whose `resolved_by` matches the holder can
 * settle the items (409 `claimed_by_other` for everyone else), so concurrent
 * sweeps stop duplicating triage work and same-kind agents can shard over
 * disjoint claimed batches. Expired claims lazily revert to `pending` on the
 * next suggestions touch — a crashed holder costs at most the TTL.
 * `?expand=context` inlines the same per-item triage context as
 * `GET /suggestions`.
 *
 * Returns `{kind, holder, claimed, claim_expires, remaining_pending, items}`;
 * an empty claim (`claimed: 0`) is a 200, not an error.
 */
export const claimSuggestionsHandler =
  (deps: SuggestionsDeps): Handler =>
  async ctx => {
    const expand = ctx.query['expand'];
    if (expand !== undefined && expand !== 'context') {
      sendError(ctx.res, 400, 'bad_request', `unknown expand: ${expand} (expected: context)`);
      return;
    }

    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendError(ctx.res, 400, 'bad_request', 'request body must be a JSON object');
        return;
      }
      body = parsed as Record<string, unknown>;
    } catch (err) {
      sendError(ctx.res, 400, 'bad_request', `invalid JSON: ${(err as Error).message}`);
      return;
    }

    const kind = body['kind'];
    if (typeof kind !== 'string' || !SUGGESTION_KINDS.has(kind)) {
      sendError(
        ctx.res,
        400,
        'bad_request',
        `kind must be one of: ${[...SUGGESTION_KINDS].join(', ')}`
      );
      return;
    }
    const holder = body['holder'];
    if (typeof holder !== 'string' || holder.trim().length === 0) {
      sendError(ctx.res, 400, 'bad_request', 'holder must be a non-empty string');
      return;
    }
    const limit = intField(body['limit'], 'limit', CLAIM_LIMIT_DEFAULT, 1, CLAIM_LIMIT_MAX);
    if (typeof limit === 'string') {
      sendError(ctx.res, 400, 'bad_request', limit);
      return;
    }
    const ttl = intField(
      body['ttl_seconds'],
      'ttl_seconds',
      CLAIM_TTL_DEFAULT_S,
      CLAIM_TTL_MIN_S,
      CLAIM_TTL_MAX_S
    );
    if (typeof ttl === 'string') {
      sendError(ctx.res, 400, 'bad_request', ttl);
      return;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    revertExpiredClaims(deps.db, nowIso);

    const ids = (
      deps.db
        .prepare(
          `SELECT id FROM suggestions
            WHERE kind = ? AND status = 'pending'
            ORDER BY created
            LIMIT ?`
        )
        .all(kind, limit) as Array<{id: string}>
    ).map(r => r.id);

    const expires = new Date(now.getTime() + ttl * 1000).toISOString();
    if (ids.length > 0) {
      deps.db
        .prepare(
          `UPDATE suggestions
              SET status = 'claimed', claimed_by = ?, claimed_at = ?, claim_expires = ?
            WHERE id IN (${ids.map(() => '?').join(',')}) AND status = 'pending'`
        )
        .run(holder, nowIso, expires, ...ids);
    }

    const items =
      ids.length > 0
        ? (
            deps.db
              .prepare(
                `SELECT ${ROW_COLUMNS} FROM suggestions
                  WHERE id IN (${ids.map(() => '?').join(',')})
                  ORDER BY created`
              )
              .all(...ids) as unknown[] as SuggestionRow[]
          ).map(rowToJson)
        : [];
    if (expand === 'context') attachContext(deps.db, items);

    const remaining = (
      deps.db
        .prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE kind = ? AND status = 'pending'`)
        .get(kind) as {n: number}
    ).n;

    sendJson(ctx.res, 200, {
      kind,
      holder,
      claimed: items.length,
      claim_expires: items.length > 0 ? expires : null,
      remaining_pending: remaining,
      items
    });
  };

const BATCH_MAX = 100;
const EDGE_TYPE_SET: ReadonlySet<string> = new Set(EDGE_TYPES);

interface BatchResult {
  id: string;
  status?: string;
  resolved_by?: string | null;
  side_effect?: Record<string, unknown>;
  error?: {code: string; message: string};
}

const payloadString = (payload: Record<string, unknown>, key: string): string | null => {
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
};

/**
 * POST /suggestions/resolve-batch — resolve many suggestions in one call,
 * applying the mechanical side effects server-side. The agent keeps the
 * judgment; the ceremony (per-id resolve + FM side-effect write, ~2 HTTP
 * calls per item) collapses into one request.
 *
 * Body: `{resolved_by?: string, items: [{id, decision: 'accept'|'reject',
 * edge_type?}]}` (≤ 100 items). `resolved_by` doubles as the claim holder
 * for claimed items.
 *
 * Side effects by kind:
 * - `tag_suggestion` accept → the tag is realized on the record's FM
 *   `tags:`; the re-import settles the row as `tag-realized`.
 * - `tag_suggestion` reject → the candidate is stripped from
 *   `agent.tags_suggested` (best-effort), then the row flips.
 * - `edge_type` accept → requires `edge_type` (a typed value, not `cites` —
 *   "cites is correct" is a reject); pins the FM `edges:` override and the
 *   scoped edge pass settles the row as `fm-override`.
 * - everything else → status flip only (their side effects carry judgment:
 *   `new_tag` minting, `duplicate` merging stay with the agent).
 *
 * Always 200: per-item failures land in `results[].error`
 * (`already_resolved`, `claimed_by_other`, `record_not_found`, …) and the
 * `failed` count — one bad item never aborts the batch.
 */
export const resolveBatchSuggestionsHandler =
  (deps: EffectDeps): Handler =>
  async ctx => {
    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendError(ctx.res, 400, 'bad_request', 'request body must be a JSON object');
        return;
      }
      body = parsed as Record<string, unknown>;
    } catch (err) {
      sendError(ctx.res, 400, 'bad_request', `invalid JSON: ${(err as Error).message}`);
      return;
    }

    const resolvedByRaw = body['resolved_by'];
    if (
      resolvedByRaw !== undefined &&
      resolvedByRaw !== null &&
      (typeof resolvedByRaw !== 'string' || resolvedByRaw.length === 0)
    ) {
      sendError(ctx.res, 400, 'bad_request', 'resolved_by must be a non-empty string when set');
      return;
    }
    const resolvedBy = typeof resolvedByRaw === 'string' ? resolvedByRaw : null;

    const itemsRaw = body['items'];
    if (!Array.isArray(itemsRaw) || itemsRaw.length === 0 || itemsRaw.length > BATCH_MAX) {
      sendError(ctx.res, 400, 'bad_request', `items must be an array of 1..${BATCH_MAX}`);
      return;
    }

    revertExpiredClaims(deps.db);

    const results: BatchResult[] = [];
    let accepted = 0;
    let rejected = 0;
    let failed = 0;
    const fail = (id: string, code: string, message: string): void => {
      ++failed;
      results.push({id, error: {code, message}});
    };

    for (const itemRaw of itemsRaw) {
      const item =
        itemRaw !== null && typeof itemRaw === 'object' && !Array.isArray(itemRaw)
          ? (itemRaw as Record<string, unknown>)
          : null;
      const id = typeof item?.['id'] === 'string' ? (item['id'] as string) : null;
      if (!item || id === null) {
        fail('', 'bad_item', 'each item must be an object with a string `id`');
        continue;
      }
      const decision = item['decision'];
      if (decision !== 'accept' && decision !== 'reject') {
        fail(id, 'bad_item', "decision must be 'accept' or 'reject'");
        continue;
      }

      const row = deps.db
        .prepare(
          `SELECT id, kind, payload, status, claimed_by, claim_expires
             FROM suggestions WHERE id = ?`
        )
        .get(id) as
        | {
            id: string;
            kind: string;
            payload: string;
            status: string;
            claimed_by: string | null;
            claim_expires: string | null;
          }
        | undefined;
      if (!row) {
        fail(id, 'suggestion_not_found', `no suggestion with id ${id}`);
        continue;
      }
      const conflict = claimConflict(row, resolvedBy);
      if (conflict) {
        fail(id, conflict.code, conflict.message);
        continue;
      }

      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(row.payload) as unknown;
        payload =
          parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
      } catch {
        payload = {};
      }

      const now = new Date().toISOString();
      let sideEffect: Record<string, unknown> | undefined;
      try {
        if (decision === 'accept') {
          if (row.kind === 'tag_suggestion') {
            const tag = payloadString(payload, 'tag');
            const recordId = payloadString(payload, 'record_id');
            if (!tag || !recordId) {
              fail(id, 'bad_payload', 'tag_suggestion payload missing tag/record_id');
              continue;
            }
            sideEffect = addTagToRecord(deps, recordId, tag);
          } else if (row.kind === 'edge_type') {
            const edgeType = item['edge_type'];
            if (
              typeof edgeType !== 'string' ||
              !EDGE_TYPE_SET.has(edgeType) ||
              edgeType === 'cites'
            ) {
              fail(
                id,
                'invalid_edge_type',
                `edge_type accept requires \`edge_type\` in: ${EDGE_TYPES.filter(t => t !== 'cites').join(', ')} — "cites is correct" is a reject`
              );
              continue;
            }
            const fromRecord = payloadString(payload, 'from_record');
            const toPath = payloadString(payload, 'to_path');
            if (!fromRecord || !toPath) {
              fail(id, 'bad_payload', 'edge_type payload missing from_record/to_path');
              continue;
            }
            sideEffect = applyEdgeOverride(deps, fromRecord, toPath, edgeType);
          }
          flipStatus(deps.db, id, 'accepted', resolvedBy, now);
        } else {
          if (row.kind === 'tag_suggestion') {
            const tag = payloadString(payload, 'tag');
            const recordId = payloadString(payload, 'record_id');
            if (tag && recordId) sideEffect = stripSuggestedTag(deps, recordId, tag);
          }
          flipStatus(deps.db, id, 'rejected', resolvedBy, now);
        }
      } catch (err) {
        if (err instanceof EffectError || err instanceof WriterError) {
          fail(id, err.code, err.message);
          continue;
        }
        throw err;
      }

      const final = deps.db
        .prepare('SELECT status, resolved_by FROM suggestions WHERE id = ?')
        .get(id) as {status: string; resolved_by: string | null};
      if (final.status === 'accepted') ++accepted;
      else if (final.status === 'rejected') ++rejected;
      results.push({
        id,
        status: final.status,
        resolved_by: final.resolved_by,
        ...(sideEffect !== undefined ? {side_effect: sideEffect} : {})
      });
    }

    sendJson(ctx.res, 200, {accepted, rejected, failed, results});
  };
