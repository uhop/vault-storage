import {existsSync, readFileSync, statSync} from 'node:fs';
import type {ServerResponse} from 'node:http';
import type {DatabaseSync} from 'node:sqlite';
import {
  AgentEnrichmentStaleFiler,
  ArchiveCandidateFiler,
  TagSuggestionFiler
} from '../../importer/file-suggestions.ts';
import {importFile} from '../../importer/import-file.ts';
import {TagsImporter} from '../../importer/import-tags.ts';
import {parseFrontmatter} from '../../markdown/frontmatter.ts';
import {RecordsRepository} from '../../records/repository.ts';
import {RECORD_STATUSES, RECORD_TYPES} from '../../records/types.ts';
import {readBodyText} from '../body.ts';
import {parsePagination, splitCsv} from '../query.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';
import {toJsonRecord} from '../serialize.ts';
import {ensureSafePath, WriterError, writeSplitRecordToDisk} from '../writer.ts';

interface RecordRow {
  record_id: string;
  file_path: string;
  parent_path: string | null;
  sequence_key: number | null;
  type: string;
  body: string;
  content_hash: string;
  title: string | null;
  created: string;
  updated: string;
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
  title: row.title,
  created: row.created,
  updated: row.updated,
  lastReferenced: row.last_referenced,
  decayScore: row.decay_score,
  status: row.status as (typeof RECORD_STATUSES)[number],
  priority: row.priority,
  archivedAt: row.archived_at,
  agentSummary: row.agent_summary,
  agentDerivedFromHash: row.agent_derived_from_hash
});

const SORT_COLUMNS: Record<string, string> = {
  priority: 'priority',
  created: 'created',
  updated: 'updated',
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
      sendError(res, err.status, err.code, err.message);
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
      sendError(res, err.status, err.code, err.message);
      return false;
    }
    throw err;
  }
  importFile(deps.records, row.file_path, abs, undefined, {
    tags: new TagsImporter(deps.db),
    agentStale: new AgentEnrichmentStaleFiler(deps.db),
    tagSuggestion: new TagSuggestionFiler(deps.db),
    archiveCandidate: new ArchiveCandidateFiler(deps.db)
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
    const row = deps.db
      .prepare('SELECT file_path FROM records WHERE record_id = ?')
      .get(id) as {file_path: string} | undefined;
    if (!row) {
      sendError(ctx.res, 404, 'record_not_found', `no record with id ${id}`);
      return;
    }
    let abs: string;
    try {
      abs = ensureSafePath(deps.vaultDataPath, row.file_path);
    } catch (err) {
      if (err instanceof WriterError) {
        sendError(ctx.res, err.status, err.code, err.message);
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
  const sql = `SELECT * FROM records ${whereClause} ${sortClause} LIMIT ? OFFSET ?`;
  const countSql = `SELECT COUNT(*) AS n FROM records ${whereClause}`;

  return {sql, countSql, bindings: [...bindings, limit, offset], countBindings: bindings};
};

const parseSort = (raw: string | undefined): {clause: string; error?: string} => {
  if (!raw) return {clause: 'ORDER BY updated DESC'};
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
