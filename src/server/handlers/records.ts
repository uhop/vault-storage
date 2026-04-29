import type {DatabaseSync} from 'node:sqlite';
import {RECORD_STATUSES, RECORD_TYPES} from '../../records/types.ts';
import {parsePagination, splitCsv} from '../query.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';
import {toJsonRecord} from '../serialize.ts';

interface RecordRow {
  record_id: string;
  file_path: string;
  parent_path: string | null;
  sequence_key: number | null;
  type: string;
  body: string;
  content_hash: string;
  created: string;
  updated: string;
  last_referenced: string | null;
  decay_score: number;
  status: string;
  priority: number;
  archived_at: string | null;
}

const rowToRecord = (row: RecordRow) => ({
  recordId: row.record_id,
  filePath: row.file_path,
  parentPath: row.parent_path,
  sequenceKey: row.sequence_key,
  type: row.type as (typeof RECORD_TYPES)[number],
  body: row.body,
  contentHash: row.content_hash,
  created: row.created,
  updated: row.updated,
  lastReferenced: row.last_referenced,
  decayScore: row.decay_score,
  status: row.status as (typeof RECORD_STATUSES)[number],
  priority: row.priority,
  archivedAt: row.archived_at
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
  (db: DatabaseSync): Handler =>
  ctx => {
    const id = ctx.params['id'];
    if (!id) {
      sendError(ctx.res, 400, 'bad_request', 'missing record_id');
      return;
    }
    const row = db.prepare('SELECT * FROM records WHERE record_id = ?').get(id) as
      | RecordRow
      | undefined;
    if (!row) {
      sendError(ctx.res, 404, 'record_not_found', `no record with id ${id}`);
      return;
    }
    const includeBody = ctx.query['exclude'] !== 'body';
    sendJson(ctx.res, 200, toJsonRecord(rowToRecord(row), {includeBody}));
  };

export const getRecordMetaHandler =
  (db: DatabaseSync): Handler =>
  ctx => {
    const id = ctx.params['id'];
    if (!id) {
      sendError(ctx.res, 400, 'bad_request', 'missing record_id');
      return;
    }
    const row = db.prepare('SELECT * FROM records WHERE record_id = ?').get(id) as
      | RecordRow
      | undefined;
    if (!row) {
      sendError(ctx.res, 404, 'record_not_found', `no record with id ${id}`);
      return;
    }
    sendJson(ctx.res, 200, toJsonRecord(rowToRecord(row), {includeBody: false}));
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
  (db: DatabaseSync): Handler =>
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
