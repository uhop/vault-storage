import {sendError} from './responses.ts';
import type {RequestContext} from './router.ts';

/**
 * Reject query keys outside `allowed` with a 400 naming the offender — a
 * typo'd filter must fail loud, not fall through to an unfiltered answer
 * (the `GET /sections` `?path=` incident). Returns true when the query is
 * clean. New endpoints adopt this from birth. An endpoint that reads no
 * query params passes {@link NO_QUERY_PARAMS} rather than skipping the call.
 */
export const rejectUnknownParams = (ctx: RequestContext, allowed: ReadonlySet<string>): boolean => {
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

/** Allowed-set for an endpoint that reads no query parameters at all. */
export const NO_QUERY_PARAMS: ReadonlySet<string> = new Set();

export interface PaginationOpts {
  /** Hard cap server-side; clamps without erroring per api-surface § Pagination. */
  maxLimit?: number;
  defaultLimit?: number;
}

export interface Pagination {
  offset: number;
  limit: number;
}

export const parsePagination = (
  query: Record<string, string>,
  opts: PaginationOpts = {}
): Pagination => {
  const maxLimit = opts.maxLimit ?? 100;
  const defaultLimit = opts.defaultLimit ?? 20;

  const offsetRaw = query['offset'];
  const limitRaw = query['limit'];

  const offset = offsetRaw === undefined ? 0 : Math.max(0, Number.parseInt(offsetRaw, 10) || 0);
  const limitParsed = limitRaw === undefined ? defaultLimit : Number.parseInt(limitRaw, 10);
  const limit = Math.min(
    maxLimit,
    Math.max(1, Number.isFinite(limitParsed) ? limitParsed : defaultLimit)
  );

  return {offset, limit};
};

/** Split a comma-separated query value into a trimmed string array. Empty input → []. */
export const splitCsv = (value: string | undefined): string[] => {
  if (!value) return [];
  return value
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0);
};

/**
 * `?exclude=body` drops body fields from a record or queue-item read; any other
 * value is a 400, the same loud failure a bad `limit` gets, never a silent
 * include. Returns null after sending the error.
 */
export const parseExclude = (ctx: RequestContext): {includeBody: boolean} | null => {
  const raw = ctx.query['exclude'];
  if (raw === undefined) return {includeBody: true};
  if (raw === 'body') return {includeBody: false};
  sendError(ctx.res, 400, 'bad_request', 'exclude must be "body"');
  return null;
};

/** A subset request: `include` null means every field; `exclude` applies on top. */
export interface FieldSpec {
  include: ReadonlySet<string> | null;
  exclude: ReadonlySet<string>;
}

const ALL_FIELDS: FieldSpec = {include: null, exclude: new Set()};

/**
 * `?fields=a,b` keeps those fields; `?fields=-a,-b` drops them — one mode per
 * request, names checked against `known` so a typo is a 400 and never a
 * silently missing column. `?exclude=body` stays as the alias it was; using
 * both is a 400. Returns null after sending the error.
 */
export const parseFields = (ctx: RequestContext, known: ReadonlySet<string>): FieldSpec | null => {
  const raw = ctx.query['fields'];
  const legacy = ctx.query['exclude'];
  if (raw !== undefined && legacy !== undefined) {
    sendError(ctx.res, 400, 'bad_request', 'pass fields or exclude, not both');
    return null;
  }
  if (raw === undefined) {
    if (legacy === undefined) return ALL_FIELDS;
    if (legacy === 'body') return {include: null, exclude: new Set(['body'])};
    sendError(ctx.res, 400, 'bad_request', 'exclude must be "body"');
    return null;
  }
  const names = raw
    .split(',')
    .map(n => n.trim())
    .filter(n => n.length > 0);
  if (names.length === 0) {
    sendError(ctx.res, 400, 'bad_request', 'fields must name at least one field');
    return null;
  }
  const negated = names.filter(n => n.startsWith('-')).length;
  if (negated !== 0 && negated !== names.length) {
    sendError(
      ctx.res,
      400,
      'bad_request',
      'fields mixes an include list and an exclude list; use one mode per request'
    );
    return null;
  }
  const bare = names.map(n => (n.startsWith('-') ? n.slice(1) : n));
  for (const name of bare) {
    if (name.includes('.')) {
      sendError(
        ctx.res,
        400,
        'bad_request',
        `fields: "${name}" — rows here are flat, no sub-object paths`
      );
      return null;
    }
    if (!known.has(name)) {
      sendError(ctx.res, 400, 'bad_request', `fields: unknown field "${name}"`);
      return null;
    }
  }
  return negated > 0
    ? {include: null, exclude: new Set(bare)}
    : {include: new Set(bare), exclude: new Set()};
};

/** Whether the row's body is worth serializing at all under `spec`. */
export const wantsBody = (spec: FieldSpec): boolean =>
  spec.include === null ? !spec.exclude.has('body') : spec.include.has('body');

/** Apply a FieldSpec to one row; `always` names the identity fields that stay whatever was asked. */
export const projectFields = <T extends object>(
  row: T,
  spec: FieldSpec,
  always: ReadonlySet<string>
): Partial<T> => {
  if (spec.include === null && spec.exclude.size === 0) return row;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    if (always.has(key)) {
      out[key] = value;
      continue;
    }
    if (spec.include !== null ? spec.include.has(key) : !spec.exclude.has(key)) out[key] = value;
  }
  return out as Partial<T>;
};
