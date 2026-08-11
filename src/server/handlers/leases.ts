// HTTP handlers over the repo-lease registry (agent-coordination design,
// D21/D23). Reads are flat lists (a handful of rows — unpaginated by design);
// mutations are POSTs with JSON bodies so resource keys with slashes and
// colons never ride in a path segment.

import {
  DEFAULT_LEASE_TTL_SECONDS,
  HOLDER_KINDS,
  LEASE_PRIORITIES,
  LeasesRepository,
  MAX_LEASE_TTL_SECONDS,
  MIN_LEASE_TTL_SECONDS,
  type ClaimRequest,
  type HolderKind,
  type Lease,
  type LeasePriority
} from '../../records/leases.ts';
import type {DatabaseSync} from 'node:sqlite';
import {readBodyText} from '../body.ts';
import {NO_QUERY_PARAMS, rejectUnknownParams} from '../query.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

interface LeaseDeps {
  db: DatabaseSync;
}

const toApi = (lease: Lease): Record<string, unknown> => ({
  resource: lease.resource,
  holder: lease.holder,
  holder_kind: lease.holderKind,
  priority: lease.priority,
  attestation: lease.attestation,
  claimed_at: lease.claimedAt,
  renewed_at: lease.renewedAt,
  expires_at: lease.expiresAt
});

const LIST_PARAMS: ReadonlySet<string> = new Set(['resource']);
const EVENTS_PARAMS: ReadonlySet<string> = new Set(['resource', 'limit']);

/** GET /leases[?resource=…] — one shape either way: {count, items}. */
export const listLeasesHandler =
  (deps: LeaseDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, LIST_PARAMS)) return;
    const repo = new LeasesRepository(deps.db);
    const resource = ctx.query['resource'];
    const items = (
      resource === undefined ? repo.list() : [repo.get(resource)].filter(l => l !== null)
    ).map(toApi);
    sendJson(ctx.res, 200, {count: items.length, items});
  };

/** GET /leases/events[?resource=…&limit=N] — the append-only transcript, newest first. */
export const leaseEventsHandler =
  (deps: LeaseDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, EVENTS_PARAMS)) return;
    const rawLimit = ctx.query['limit'];
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      sendError(ctx.res, 400, 'bad_request', 'limit must be an integer in 1..1000');
      return;
    }
    const repo = new LeasesRepository(deps.db);
    const items = repo.events(ctx.query['resource'], limit);
    sendJson(ctx.res, 200, {count: items.length, items});
  };

interface ParsedBody {
  body: Record<string, unknown>;
}

const readJsonBody = async (ctx: Parameters<Handler>[0]): Promise<ParsedBody | null> => {
  let raw: string;
  try {
    raw = await readBodyText(ctx.req);
  } catch (err) {
    sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendError(ctx.res, 400, 'bad_request', 'request body must be a JSON object');
      return null;
    }
    return {body: parsed as Record<string, unknown>};
  } catch (err) {
    sendError(ctx.res, 400, 'bad_request', `invalid JSON: ${(err as Error).message}`);
    return null;
  }
};

const requireString = (
  ctx: Parameters<Handler>[0],
  body: Record<string, unknown>,
  key: string
): string | null => {
  const v = body[key];
  if (typeof v !== 'string' || v.length === 0) {
    sendError(ctx.res, 400, 'bad_request', `${key} must be a non-empty string`);
    return null;
  }
  return v;
};

const parseTtl = (
  ctx: Parameters<Handler>[0],
  body: Record<string, unknown>
): number | null | undefined => {
  const raw = body['ttl_seconds'];
  if (raw === undefined) return undefined;
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < MIN_LEASE_TTL_SECONDS ||
    raw > MAX_LEASE_TTL_SECONDS
  ) {
    sendError(
      ctx.res,
      400,
      'bad_request',
      `ttl_seconds must be an integer in ${MIN_LEASE_TTL_SECONDS}..${MAX_LEASE_TTL_SECONDS}`
    );
    return null;
  }
  return raw;
};

/**
 * POST /leases/claim — atomic claim; a loser gets a 409, never a silent
 * split. Idempotent for the current holder (re-claim = renew). Preemption per
 * the D23 lattice: human > cwd agent > side agent.
 */
export const claimLeaseHandler =
  (deps: LeaseDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const parsed = await readJsonBody(ctx);
    if (!parsed) return;
    const {body} = parsed;

    const resource = requireString(ctx, body, 'resource');
    if (resource === null) return;
    const holder = requireString(ctx, body, 'holder');
    if (holder === null) return;

    const kindRaw = body['kind'] ?? 'agent';
    if (typeof kindRaw !== 'string' || !(HOLDER_KINDS as readonly string[]).includes(kindRaw)) {
      sendError(ctx.res, 400, 'bad_request', `kind must be one of: ${HOLDER_KINDS.join(', ')}`);
      return;
    }
    const kind = kindRaw as HolderKind;

    const priorityRaw = body['priority'];
    if (
      priorityRaw !== undefined &&
      (typeof priorityRaw !== 'string' ||
        !(LEASE_PRIORITIES as readonly string[]).includes(priorityRaw))
    ) {
      sendError(
        ctx.res,
        400,
        'bad_request',
        `priority must be one of: ${LEASE_PRIORITIES.join(', ')}`
      );
      return;
    }

    const attestationRaw = body['attestation'];
    if (
      attestationRaw !== undefined &&
      (typeof attestationRaw !== 'string' || attestationRaw.length === 0)
    ) {
      sendError(ctx.res, 400, 'bad_request', 'attestation must be a non-empty string when set');
      return;
    }

    const ttl = parseTtl(ctx, body);
    if (ttl === null) return;

    if (kind === 'human' && (priorityRaw !== undefined || ttl !== undefined)) {
      sendError(
        ctx.res,
        400,
        'bad_request',
        'human holders take no priority and no ttl_seconds — they are never preempted and never expire'
      );
      return;
    }

    const req: ClaimRequest = {
      resource,
      holder,
      holderKind: kind,
      ...(priorityRaw !== undefined ? {priority: priorityRaw as LeasePriority} : {}),
      ...(attestationRaw !== undefined ? {attestation: attestationRaw as string} : {}),
      ...(ttl !== undefined ? {ttlSeconds: ttl} : {})
    };

    const outcome = new LeasesRepository(deps.db).claim(req);
    if (outcome.status === 'conflict') {
      sendError(
        ctx.res,
        409,
        'claimed_by_other',
        `${resource} is held by ${outcome.current.holder}`,
        {
          current: toApi(outcome.current)
        }
      );
      return;
    }
    sendJson(ctx.res, 200, {status: outcome.status, lease: toApi(outcome.lease)});
  };

/** POST /leases/renew — holder must match; refreshes the TTL (no-op expiry for humans). */
export const renewLeaseHandler =
  (deps: LeaseDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const parsed = await readJsonBody(ctx);
    if (!parsed) return;
    const {body} = parsed;
    const resource = requireString(ctx, body, 'resource');
    if (resource === null) return;
    const holder = requireString(ctx, body, 'holder');
    if (holder === null) return;
    const ttl = parseTtl(ctx, body);
    if (ttl === null) return;

    const outcome = new LeasesRepository(deps.db).renew(resource, holder, ttl);
    respondToOp(ctx, resource, holder, outcome);
  };

/** POST /leases/release — holder must match unless `force` (the operator's hatch). */
export const releaseLeaseHandler =
  (deps: LeaseDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const parsed = await readJsonBody(ctx);
    if (!parsed) return;
    const {body} = parsed;
    const resource = requireString(ctx, body, 'resource');
    if (resource === null) return;
    const holder = requireString(ctx, body, 'holder');
    if (holder === null) return;
    const force = body['force'];
    if (force !== undefined && typeof force !== 'boolean') {
      sendError(ctx.res, 400, 'bad_request', 'force must be a boolean when set');
      return;
    }

    const outcome = new LeasesRepository(deps.db).release(resource, holder, force === true);
    respondToOp(ctx, resource, holder, outcome);
  };

/** POST /leases/transfer — atomic reassignment by the current holder (D23). */
export const transferLeaseHandler =
  (deps: LeaseDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const parsed = await readJsonBody(ctx);
    if (!parsed) return;
    const {body} = parsed;
    const resource = requireString(ctx, body, 'resource');
    if (resource === null) return;
    const holder = requireString(ctx, body, 'holder');
    if (holder === null) return;
    const toHolder = requireString(ctx, body, 'to_holder');
    if (toHolder === null) return;

    const toKindRaw = body['to_kind'] ?? 'agent';
    if (typeof toKindRaw !== 'string' || !(HOLDER_KINDS as readonly string[]).includes(toKindRaw)) {
      sendError(ctx.res, 400, 'bad_request', `to_kind must be one of: ${HOLDER_KINDS.join(', ')}`);
      return;
    }
    const toPriorityRaw = body['to_priority'];
    if (
      toPriorityRaw !== undefined &&
      (typeof toPriorityRaw !== 'string' ||
        !(LEASE_PRIORITIES as readonly string[]).includes(toPriorityRaw))
    ) {
      sendError(
        ctx.res,
        400,
        'bad_request',
        `to_priority must be one of: ${LEASE_PRIORITIES.join(', ')}`
      );
      return;
    }
    const ttl = parseTtl(ctx, body);
    if (ttl === null) return;

    const outcome = new LeasesRepository(deps.db).transfer(resource, holder, {
      holder: toHolder,
      holderKind: toKindRaw as HolderKind,
      ...(toPriorityRaw !== undefined ? {priority: toPriorityRaw as LeasePriority} : {}),
      ...(ttl !== undefined ? {ttlSeconds: ttl} : {})
    });
    respondToOp(ctx, resource, holder, outcome);
  };

const respondToOp = (
  ctx: Parameters<Handler>[0],
  resource: string,
  holder: string,
  outcome: ReturnType<LeasesRepository['renew']>
): void => {
  switch (outcome.status) {
    case 'ok':
      sendJson(ctx.res, 200, {status: 'ok', lease: toApi(outcome.lease)});
      return;
    case 'released':
      sendJson(ctx.res, 200, {status: 'released', resource});
      return;
    case 'not_found':
      sendError(ctx.res, 404, 'lease_not_found', `no lease on ${resource}`);
      return;
    case 'not_holder':
      sendError(
        ctx.res,
        409,
        'claimed_by_other',
        `${resource} is held by ${outcome.current.holder}, not ${holder}`,
        {
          current: toApi(outcome.current)
        }
      );
      return;
  }
};

/** Default TTL surfaced for clients that want to display it; claims may override per call. */
export const LEASE_DEFAULTS = {ttl_seconds: DEFAULT_LEASE_TTL_SECONDS};
