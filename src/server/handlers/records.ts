import {existsSync, readFileSync, statSync} from 'node:fs';
import type {ServerResponse} from 'node:http';
import type {DatabaseSync} from 'node:sqlite';
import {SuggestionFiler} from '../../importer/file-suggestions.ts';
import {importFile} from '../../importer/import-file.ts';
import {TagsImporter} from '../../importer/import-tags.ts';
import {parseFrontmatter} from '../../markdown/frontmatter.ts';
import {RECORD_COLUMNS, RecordsRepository} from '../../records/repository.ts';
import {RECORD_STATUSES, RECORD_TYPES} from '../../records/types.ts';
import {readBodyText} from '../body.ts';
import {parsePagination, splitCsv} from '../query.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';
import {toJsonRecord} from '../serialize.ts';
import {
  AUTO_MANAGED_KEYS,
  ensureSafePath,
  INDEXER_OVERRIDE_KEYS,
  WriterError,
  writeSplitRecordToDisk
} from '../writer.ts';

interface RecordRow {
  record_id: string;
  file_path: string;
  parent_path: string | null;
  sequence_key: number | null;
  type: string;
  body: string;
  content_hash: string;
  body_hash: string;
  title: string | null;
  created: string;
  updated: string;
  modified_at: string | null;
  last_referenced: string | null;
  decay_score: number;
  status: string;
  priority: number;
  archived_at: string | null;
  agent_summary: string | null;
  agent_derived_from_hash: string | null;
}

const rowToRecord = (row: RecordRow) => ({
  recordId: row.record_id,
  filePath: row.file_path,
  parentPath: row.parent_path,
  sequenceKey: row.sequence_key,
  type: row.type as (typeof RECORD_TYPES)[number],
  body: row.body,
  contentHash: row.content_hash,
  bodyHash: row.body_hash,
  title: row.title,
  created: row.created,
  updated: row.updated,
  modifiedAt: row.modified_at,
  lastReferenced: row.last_referenced,
  decayScore: row.decay_score,
  status: row.status as (typeof RECORD_STATUSES)[number],
  priority: row.priority,
  archivedAt: row.archived_at,
  agentSummary: row.agent_summary,
  agentDerivedFromHash: row.agent_derived_from_hash
});

// modified_at sorts by COALESCE(modified_at, updated): rows re-imported since
// schema 0012 order by precise timestamp; older rows fall back to date-only
// `updated`. This is also the default sort (see parseSort) so "recency" reflects
// true sub-day write order.
const RECENCY_SORT = 'COALESCE(modified_at, updated)';
const SORT_COLUMNS: Record<string, string> = {
  priority: 'priority',
  created: 'created',
  updated: 'updated',
  modified_at: RECENCY_SORT,
  last_referenced: 'last_referenced',
  decay_score: 'decay_score',
  file_path: 'file_path'
};

const TYPE_SET: ReadonlySet<string> = new Set(RECORD_TYPES);
const STATUS_SET: ReadonlySet<string> = new Set(RECORD_STATUSES);

export const getRecordHandler =
  (deps: {records: RecordsRepository}): Handler =>
  ctx => {
    const id = ctx.params['id'];
    if (!id) {
      sendError(ctx.res, 400, 'bad_request', 'missing record_id');
      return;
    }
    const record = deps.records.getById(id);
    if (!record) {
      sendError(ctx.res, 404, 'record_not_found', `no record with id ${id}`);
      return;
    }
    // Phase E: bump last_referenced for decay-score reinforcement. Single-
    // record reads count as a reference; the bulk listing path does not.
    // Update both the DB row and the in-memory copy so this response
    // reflects the freshly-bumped clock (decay_score = 1.0).
    const refStamp = new Date().toISOString();
    deps.records.bumpLastReferenced(id, refStamp);
    const includeBody = ctx.query['exclude'] !== 'body';
    sendJson(ctx.res, 200, toJsonRecord({...record, lastReferenced: refStamp}, {includeBody}));
  };

export const getRecordMetaHandler =
  (deps: {records: RecordsRepository}): Handler =>
  ctx => {
    const id = ctx.params['id'];
    if (!id) {
      sendError(ctx.res, 400, 'bad_request', 'missing record_id');
      return;
    }
    const record = deps.records.getById(id);
    if (!record) {
      sendError(ctx.res, 404, 'record_not_found', `no record with id ${id}`);
      return;
    }
    sendJson(ctx.res, 200, toJsonRecord(record, {includeBody: false}));
  };

interface FmHandlerDeps {
  db: DatabaseSync;
  vaultDataPath: string;
  records: RecordsRepository;
}

// Tag shape rule from src/server/handlers/tags.ts — keep in sync.
const TAG_RE = /^[a-z0-9][a-z0-9-]*$/;

interface RecordPathRow {
  record_id: string;
  file_path: string;
}

const resolveRecord = (
  deps: FmHandlerDeps,
  id: string | undefined,
  res: ServerResponse
): RecordPathRow | null => {
  if (!id) {
    sendError(res, 400, 'bad_request', 'missing record_id');
    return null;
  }
  const row = deps.db
    .prepare('SELECT record_id, file_path FROM records WHERE record_id = ?')
    .get(id) as RecordPathRow | undefined;
  if (!row) {
    sendError(res, 404, 'record_not_found', `no record with id ${id}`);
    return null;
  }
  return row;
};

const resolveAbsPath = (
  deps: FmHandlerDeps,
  filePath: string,
  res: ServerResponse
): string | null => {
  let abs: string;
  try {
    abs = ensureSafePath(deps.vaultDataPath, filePath);
  } catch (err) {
    if (err instanceof WriterError) {
      sendError(res, err.status, err.code, err.message, err.details);
      return null;
    }
    throw err;
  }
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    sendError(res, 404, 'file_not_found', `no file at ${filePath}`);
    return null;
  }
  return abs;
};

interface FmReadResult {
  body: string;
  tags: string[];
}

const readFmTags = (abs: string): FmReadResult => {
  const {data, body} = parseFrontmatter(readFileSync(abs, 'utf8'));
  const raw = data['tags'];
  const tags = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
  return {body, tags};
};

const persistTags = (
  deps: FmHandlerDeps,
  row: RecordPathRow,
  abs: string,
  newTags: string[],
  body: string,
  res: ServerResponse
): boolean => {
  try {
    writeSplitRecordToDisk({
      filePath: row.file_path,
      existing: deps.records.getById(row.record_id),
      frontmatter: {tags: newTags},
      body,
      vaultDataPath: deps.vaultDataPath
    });
  } catch (err) {
    if (err instanceof WriterError) {
      sendError(res, err.status, err.code, err.message, err.details);
      return false;
    }
    throw err;
  }
  importFile(deps.records, row.file_path, abs, undefined, {
    tags: new TagsImporter(deps.db),
    agentStale: new SuggestionFiler(deps.db, 'agent_enrichment_stale'),
    tagSuggestion: new SuggestionFiler(deps.db, 'tag_suggestion'),
    archiveCandidate: new SuggestionFiler(deps.db, 'archive_candidate')
  });
  return true;
};

/**
 * GET /sections/{id}/tags — list the record's on-disk FM tags. Reads
 * straight from disk like `/sections/{id}/fm`, so it sees the file's actual
 * `tags:` array — no canonical-resolution projection.
 */
export const getRecordTagsHandler =
  (deps: FmHandlerDeps): Handler =>
  ctx => {
    const row = resolveRecord(deps, ctx.params['id'], ctx.res);
    if (!row) return;
    const abs = resolveAbsPath(deps, row.file_path, ctx.res);
    if (!abs) return;
    const {tags} = readFmTags(abs);
    sendJson(ctx.res, 200, {tags});
  };

/**
 * POST /sections/{id}/tags — add a tag to the record's FM tag array. Body:
 * `{tag: string}`. The whole add-tag-to-record operation runs server-side
 * (read FM → mutate array → write back → reimport), so callers don't ship
 * the existing array over the wire and there's no TOCTOU window where a
 * concurrent write can be silently clobbered by a stale read-modify-write.
 *
 * Set-semantics: re-POSTing an existing tag is a 200 no-op (returns the
 * unchanged tag list). Tag must match the taxonomy shape rule (lowercase
 * alphanumeric + hyphens, leading char [a-z0-9]) — canonical-vs-alias is
 * not resolved here; the tag is stored verbatim in FM and the next import's
 * `TagsImporter` handles taxonomy mapping into the `tags(record_id, tag)`
 * table.
 */
export const postRecordTagHandler =
  (deps: FmHandlerDeps): Handler =>
  async ctx => {
    const row = resolveRecord(deps, ctx.params['id'], ctx.res);
    if (!row) return;
    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendError(ctx.res, 400, 'bad_request', 'body must be JSON');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendError(ctx.res, 400, 'bad_request', 'body must be a JSON object');
      return;
    }
    const tag = (parsed as Record<string, unknown>)['tag'];
    if (typeof tag !== 'string') {
      sendError(ctx.res, 400, 'bad_request', 'body must contain `tag` as a string');
      return;
    }
    if (!TAG_RE.test(tag)) {
      sendError(
        ctx.res,
        400,
        'invalid_tag',
        'tag must match [a-z0-9][a-z0-9-]* (lowercase alphanumeric + hyphens, leading [a-z0-9])'
      );
      return;
    }
    const abs = resolveAbsPath(deps, row.file_path, ctx.res);
    if (!abs) return;
    const {body, tags} = readFmTags(abs);
    if (tags.includes(tag)) {
      sendJson(ctx.res, 200, {tags});
      return;
    }
    const finalTags = [...tags, tag];
    if (!persistTags(deps, row, abs, finalTags, body, ctx.res)) return;
    sendJson(ctx.res, 200, {tags: finalTags});
  };

/**
 * DELETE /sections/{id}/tags/{tag} — remove a tag from the record's FM tag
 * array. Idempotent: removing a tag that isn't present is a 200 no-op. Tag
 * is matched literally against the FM array; if the FM has the canonical
 * and the caller passes an alias (or vice versa), the operation is a no-op.
 * Resolve via `GET /sections/{id}/tags` (or `/sections/{id}/fm`) first if
 * the exact on-disk form is unclear.
 */
export const deleteRecordTagHandler =
  (deps: FmHandlerDeps): Handler =>
  ctx => {
    const row = resolveRecord(deps, ctx.params['id'], ctx.res);
    if (!row) return;
    const tag = ctx.params['tag'];
    if (!tag) {
      sendError(ctx.res, 400, 'bad_request', 'missing tag');
      return;
    }
    const abs = resolveAbsPath(deps, row.file_path, ctx.res);
    if (!abs) return;
    const {body, tags} = readFmTags(abs);
    if (!tags.includes(tag)) {
      sendJson(ctx.res, 200, {tags});
      return;
    }
    const finalTags = tags.filter(t => t !== tag);
    if (!persistTags(deps, row, abs, finalTags, body, ctx.res)) return;
    sendJson(ctx.res, 200, {tags: finalTags});
  };

/**
 * GET /sections/{id}/fm — return the on-disk frontmatter parsed as JSON,
 * symmetric to the JSON write path's `{frontmatter, body}` payload. Reads the
 * file directly (not the DB), so the response reflects what's actually on
 * disk — including FM fields that haven't been promoted to the indexer's
 * schema (or that go through server-side transformations like tag canonical-
 * resolution). Callers doing read-modify-write on FM should use this instead
 * of any indexer-projected view; that view drops anything the resolver
 * couldn't map, and a write-back round-trip would silently strip those keys.
 */
export const getRecordFmHandler =
  (deps: FmHandlerDeps): Handler =>
  ctx => {
    const id = ctx.params['id'];
    if (!id) {
      sendError(ctx.res, 400, 'bad_request', 'missing record_id');
      return;
    }
    const row = deps.db.prepare('SELECT file_path FROM records WHERE record_id = ?').get(id) as
      | {file_path: string}
      | undefined;
    if (!row) {
      sendError(ctx.res, 404, 'record_not_found', `no record with id ${id}`);
      return;
    }
    let abs: string;
    try {
      abs = ensureSafePath(deps.vaultDataPath, row.file_path);
    } catch (err) {
      if (err instanceof WriterError) {
        sendError(ctx.res, err.status, err.code, err.message, err.details);
        return;
      }
      throw err;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      sendError(ctx.res, 404, 'file_not_found', `no file at ${row.file_path}`);
      return;
    }
    const {data, body} = parseFrontmatter(readFileSync(abs, 'utf8'));
    const includeBody = ctx.query['exclude'] !== 'body';
    const response: {frontmatter: Record<string, unknown>; body?: string} = {frontmatter: data};
    if (includeBody) response.body = body;
    sendJson(ctx.res, 200, response);
  };

/**
 * Parse an RFC 6901 JSON Pointer into segments. The pointer must address a
 * named FM field (depth ≥ 1) — the root is not patchable.
 */
const parseFmPointer = (pointer: string): string[] => {
  if (typeof pointer !== 'string' || pointer.length === 0 || pointer === '/') {
    throw new WriterError('path must address an FM field, not the root', 'invalid_pointer', 400);
  }
  if (!pointer.startsWith('/')) {
    throw new WriterError(
      `path must start with '/' (RFC 6901): ${pointer}`,
      'invalid_pointer',
      400
    );
  }
  // Unescape order per RFC 6901: ~1 → '/', then ~0 → '~'.
  return pointer
    .slice(1)
    .split('/')
    .map(seg => seg.replace(/~1/g, '/').replace(/~0/g, '~'));
};

/** Structural equality for FM array members (string tags in practice). */
const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== typeof b) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    if (Array.isArray(b) || typeof b !== 'object') return false;
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    return (
      ka.length === kb.length &&
      ka.every(k => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return false;
};

/**
 * Top-level FM keys PATCH refuses to touch, with the reason used in the 400.
 * `tags` is writable in principle but owned by the taxonomy-aware membership
 * primitives — going through them keeps the shape rule + canonical-resolution
 * behavior in one place.
 */
const protectedFmRoot = (key: string): string | null => {
  if (AUTO_MANAGED_KEYS.has(key)) return 'auto-managed (DB identity / reflection fields)';
  if (INDEXER_OVERRIDE_KEYS.has(key)) return 'indexer-managed (stamped on every write)';
  if (key === 'tags') return 'use POST /sections/{id}/tags / DELETE /sections/{id}/tags/{tag}';
  return null;
};

interface FmPatchOp {
  op: 'add' | 'remove';
  path: string;
  value: unknown;
}

interface FmPatchResult {
  changed: boolean;
  /** Final content of the addressed array, or null when the path is absent. */
  array: unknown[] | null;
}

/**
 * Apply one membership op to the in-memory FM object (mutating it).
 *
 * `add` creates missing intermediate objects and a missing target array;
 * an explicit `null` along the way counts as missing (YAML's empty value).
 * `remove` on a missing path is an idempotent no-op. Intermediates that
 * exist as non-objects, and targets that exist as non-arrays, are 400s —
 * this endpoint does array membership only.
 */
const applyFmMembershipOp = (fm: Record<string, unknown>, op: FmPatchOp): FmPatchResult => {
  const segments = parseFmPointer(op.path);
  const rootKey = segments[0]!;
  const reason = protectedFmRoot(rootKey);
  if (reason) {
    throw new WriterError(`'${rootKey}' is not patchable — ${reason}`, 'protected_field', 400);
  }

  let node: Record<string, unknown> = fm;
  for (let i = 0; i < segments.length - 1; ++i) {
    const seg = segments[i]!;
    const next = node[seg];
    if (next === undefined || next === null) {
      if (op.op === 'remove') return {changed: false, array: null};
      const fresh: Record<string, unknown> = {};
      node[seg] = fresh;
      node = fresh;
    } else if (typeof next === 'object' && !Array.isArray(next)) {
      node = next as Record<string, unknown>;
    } else {
      throw new WriterError(
        `'/${segments.slice(0, i + 1).join('/')}' is not an object — cannot descend into it`,
        'invalid_target',
        400
      );
    }
  }

  const leaf = segments[segments.length - 1]!;
  const target = node[leaf];
  if (target === undefined || target === null) {
    if (op.op === 'remove') return {changed: false, array: null};
    const created = [op.value];
    node[leaf] = created;
    return {changed: true, array: created};
  }
  if (!Array.isArray(target)) {
    throw new WriterError(`'${op.path}' is not an array`, 'invalid_target', 400);
  }
  if (op.op === 'add') {
    if (target.some(v => deepEqual(v, op.value))) return {changed: false, array: target};
    target.push(op.value);
    return {changed: true, array: target};
  }
  const filtered = target.filter(v => !deepEqual(v, op.value));
  if (filtered.length === target.length) return {changed: false, array: target};
  node[leaf] = filtered;
  return {changed: true, array: filtered};
};

/**
 * PATCH /sections/{id}/fm — atomic value-based membership ops on FM arrays.
 *
 * Body: `{ops: [{op: "add" | "remove", path: "/agent/tags_suggested",
 * value: <json>}, …]}`. Paths are RFC 6901 JSON Pointers addressing the
 * **array itself**, not an element; ops are value-based set semantics —
 * `add` appends unless a structurally-equal member exists, `remove` drops
 * every structurally-equal member, both idempotent. The whole request is
 * atomic: ops apply to an in-memory copy and nothing is written unless all
 * of them validate; a no-change request (every op a no-op) skips the disk
 * write and re-import entirely, so it never churns `updated` or refiles
 * suggestions.
 *
 * This is deliberately *not* RFC 6902: its `remove` addresses elements by
 * index, which would force callers back into read-find-index-write — the
 * exact TOCTOU shape this primitive exists to retire (the server applies
 * the whole read-modify-write atomically instead; see
 * `topics/atomic-membership-primitive-vs-read-modify-write`). Generalizes
 * the `tags:` membership endpoints to every agent-managed FM array
 * (`agent.tags_suggested`, `agent.related_proposed`, `related`, …).
 * Motivating case: a durable `tag_suggestion` reject must also remove the
 * tag from `agent.tags_suggested`, which previously needed a full FM PUT.
 *
 * Returns 200 `{changed, results: [{op, path, changed, array}]}` where
 * `array` is the final content at each path (null when absent).
 */
export const patchRecordFmHandler =
  (deps: FmHandlerDeps): Handler =>
  async ctx => {
    const row = resolveRecord(deps, ctx.params['id'], ctx.res);
    if (!row) return;

    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendError(ctx.res, 400, 'bad_request', 'body must be JSON');
      return;
    }
    const opsRaw = (parsed as Record<string, unknown> | null)?.['ops'];
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !Array.isArray(opsRaw) ||
      opsRaw.length === 0
    ) {
      sendError(ctx.res, 400, 'bad_request', 'body must be `{ops: [...]}` with at least one op');
      return;
    }
    const ops: FmPatchOp[] = [];
    for (let i = 0; i < opsRaw.length; ++i) {
      const o = opsRaw[i] as Record<string, unknown> | null;
      if (!o || typeof o !== 'object' || Array.isArray(o)) {
        sendError(ctx.res, 400, 'bad_request', `ops[${i}] must be an object`);
        return;
      }
      if (o['op'] !== 'add' && o['op'] !== 'remove') {
        sendError(ctx.res, 400, 'bad_request', `ops[${i}].op must be "add" or "remove"`);
        return;
      }
      if (typeof o['path'] !== 'string') {
        sendError(ctx.res, 400, 'bad_request', `ops[${i}].path must be a string`);
        return;
      }
      if (!('value' in o)) {
        sendError(ctx.res, 400, 'bad_request', `ops[${i}].value is required (ops are value-based)`);
        return;
      }
      ops.push({op: o['op'], path: o['path'], value: o['value']});
    }

    const abs = resolveAbsPath(deps, row.file_path, ctx.res);
    if (!abs) return;
    const {data: fm, body} = parseFrontmatter(readFileSync(abs, 'utf8'));

    const results: Array<{op: string; path: string; changed: boolean; array: unknown[] | null}> =
      [];
    const touchedRoots = new Set<string>();
    try {
      for (let i = 0; i < ops.length; ++i) {
        const op = ops[i]!;
        const result = applyFmMembershipOp(fm, op);
        if (result.changed) touchedRoots.add(parseFmPointer(op.path)[0]!);
        results.push({op: op.op, path: op.path, changed: result.changed, array: result.array});
      }
    } catch (err) {
      if (err instanceof WriterError) {
        sendError(ctx.res, err.status, err.code, err.message, err.details);
        return;
      }
      throw err;
    }

    if (touchedRoots.size > 0) {
      // Send only the mutated top-level keys — writeSplitRecordToDisk merges
      // request FM over on-disk FM at the top level, so each touched root
      // must go over complete (it does: ops mutated the object read from
      // disk) while untouched roots round-trip from disk unchanged.
      const requestFm: Record<string, unknown> = {};
      for (const key of touchedRoots) requestFm[key] = fm[key];
      try {
        writeSplitRecordToDisk({
          filePath: row.file_path,
          existing: deps.records.getById(row.record_id),
          frontmatter: requestFm,
          body,
          vaultDataPath: deps.vaultDataPath
        });
      } catch (err) {
        if (err instanceof WriterError) {
          sendError(ctx.res, err.status, err.code, err.message, err.details);
          return;
        }
        throw err;
      }
      importFile(deps.records, row.file_path, abs, undefined, {
        tags: new TagsImporter(deps.db),
        agentStale: new SuggestionFiler(deps.db, 'agent_enrichment_stale'),
        tagSuggestion: new SuggestionFiler(deps.db, 'tag_suggestion'),
        archiveCandidate: new SuggestionFiler(deps.db, 'archive_candidate')
      });
    }

    sendJson(ctx.res, 200, {changed: touchedRoots.size > 0, results});
  };

interface ListFilters {
  recordIds: string[];
  filePath: string | undefined;
  filePrefix: string | undefined;
  types: string[];
  statuses: string[];
  priorityMin: number | undefined;
  priorityMax: number | undefined;
  updatedSince: string | undefined;
}

const parseListFilters = (query: Record<string, string>): ListFilters | string => {
  const types = splitCsv(query['type']);
  for (const t of types) {
    if (!TYPE_SET.has(t)) return `unknown type: ${t}`;
  }
  const statuses = splitCsv(query['status']);
  for (const s of statuses) {
    if (!STATUS_SET.has(s)) return `unknown status: ${s}`;
  }

  const parseIntOpt = (v: string | undefined): number | undefined | string => {
    if (v === undefined) return undefined;
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n)) return `not a number: ${v}`;
    return n;
  };
  const minRaw = parseIntOpt(query['priority_min']);
  if (typeof minRaw === 'string') return minRaw;
  const maxRaw = parseIntOpt(query['priority_max']);
  if (typeof maxRaw === 'string') return maxRaw;

  return {
    recordIds: splitCsv(query['record_ids']),
    filePath: query['file_path'],
    filePrefix: query['file_prefix'],
    types,
    statuses,
    priorityMin: minRaw,
    priorityMax: maxRaw,
    updatedSince: query['updated_since']
  };
};

const buildListSql = (
  filters: ListFilters,
  sortClause: string,
  limit: number,
  offset: number
): {sql: string; countSql: string; bindings: unknown[]; countBindings: unknown[]} => {
  const where: string[] = [];
  const bindings: unknown[] = [];

  if (filters.recordIds.length > 0) {
    const placeholders = filters.recordIds.map(() => '?').join(',');
    where.push(`record_id IN (${placeholders})`);
    bindings.push(...filters.recordIds);
  }
  if (filters.filePath) {
    where.push('file_path = ?');
    bindings.push(filters.filePath);
  }
  if (filters.filePrefix) {
    where.push('file_path LIKE ? ESCAPE ' + "'\\'");
    // Escape SQL LIKE wildcards in user input.
    const escaped = filters.filePrefix.replace(/[\\%_]/g, '\\$&');
    bindings.push(`${escaped}%`);
  }
  if (filters.types.length > 0) {
    const placeholders = filters.types.map(() => '?').join(',');
    where.push(`type IN (${placeholders})`);
    bindings.push(...filters.types);
  }
  if (filters.statuses.length > 0) {
    const placeholders = filters.statuses.map(() => '?').join(',');
    where.push(`status IN (${placeholders})`);
    bindings.push(...filters.statuses);
  }
  if (filters.priorityMin !== undefined) {
    where.push('priority >= ?');
    bindings.push(filters.priorityMin);
  }
  if (filters.priorityMax !== undefined) {
    where.push('priority <= ?');
    bindings.push(filters.priorityMax);
  }
  if (filters.updatedSince) {
    where.push('updated >= ?');
    bindings.push(filters.updatedSince);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT ${RECORD_COLUMNS} FROM records ${whereClause} ${sortClause} LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) AS n FROM records ${whereClause}`;

  return {sql, countSql, bindings: [...bindings, limit, offset], countBindings: bindings};
};

const parseSort = (raw: string | undefined): {clause: string; error?: string} => {
  if (!raw) return {clause: `ORDER BY ${RECENCY_SORT} DESC`};
  const desc = !raw.endsWith('_asc');
  const colName = desc ? raw : raw.slice(0, -'_asc'.length);
  const column = SORT_COLUMNS[colName];
  if (!column) return {clause: '', error: `unknown sort column: ${colName}`};
  return {clause: `ORDER BY ${column} ${desc ? 'DESC' : 'ASC'}`};
};

export const listRecordsHandler =
  ({db}: {db: DatabaseSync}): Handler =>
  ctx => {
    const filters = parseListFilters(ctx.query);
    if (typeof filters === 'string') {
      sendError(ctx.res, 400, 'bad_request', filters);
      return;
    }
    const sort = parseSort(ctx.query['sort']);
    if (sort.error) {
      sendError(ctx.res, 400, 'bad_request', sort.error);
      return;
    }
    const {offset, limit} = parsePagination(ctx.query);
    const includeBody = ctx.query['exclude'] !== 'body';

    const {sql, countSql, bindings, countBindings} = buildListSql(
      filters,
      sort.clause,
      limit,
      offset
    );

    const rows = db.prepare(sql).all(...(bindings as never[])) as unknown[] as RecordRow[];
    const total = (db.prepare(countSql).get(...(countBindings as never[])) as {n: number}).n;

    sendJson(ctx.res, 200, {
      items: rows.map(rowToRecord).map(r => toJsonRecord(r, {includeBody})),
      offset,
      limit,
      total
    });
  };
