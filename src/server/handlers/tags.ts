import type {DatabaseSync} from 'node:sqlite';
import {RecordsRepository} from '../../records/repository.ts';
import {parsePagination} from '../query.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';
import {toJsonRecord} from '../serialize.ts';

interface TagsDeps {
  db: DatabaseSync;
}

/**
 * GET /tags?prefix=&offset=&limit=
 * List managed tags with per-tag record_count. Sorted by record_count DESC.
 */
export const listTagsHandler =
  (deps: TagsDeps): Handler =>
  ctx => {
    const {offset, limit} = parsePagination(ctx.query);
    const prefix = ctx.query['prefix'];

    const where: string[] = [];
    const bindings: string[] = [];
    if (prefix !== undefined && prefix.length > 0) {
      const escaped = prefix.replace(/[\\%_]/g, '\\$&');
      where.push("t.tag LIKE ? ESCAPE '\\'");
      bindings.push(`${escaped}%`);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const sql = `
      SELECT t.tag AS tag,
             COALESCE(COUNT(tags.record_id), 0) AS record_count
        FROM tags_taxonomy t
        LEFT JOIN tags ON tags.tag = t.tag
        ${whereClause}
       GROUP BY t.tag
       ORDER BY record_count DESC, t.tag ASC
       LIMIT ? OFFSET ?`;
    const countSql = `SELECT COUNT(*) AS n FROM tags_taxonomy t ${whereClause}`;

    const rows = deps.db.prepare(sql).all(...bindings, limit, offset) as unknown[] as {
      tag: string;
      record_count: number;
    }[];
    const total = (deps.db.prepare(countSql).get(...bindings) as {n: number}).n;

    sendJson(ctx.res, 200, {
      items: rows.map(r => ({tag: r.tag, record_count: r.record_count})),
      offset,
      limit,
      total
    });
  };

/**
 * GET /tags/{tag}/records?offset=&limit=
 * List records carrying the given tag. Same envelope as `/sections`.
 */
export const recordsByTagHandler =
  (deps: TagsDeps): Handler =>
  ctx => {
    const tag = ctx.params['tag'];
    if (!tag) {
      sendError(ctx.res, 400, 'bad_request', 'missing tag');
      return;
    }

    // Resolve aliases so the caller can use either canonical or alias form.
    const aliasRow = deps.db
      .prepare('SELECT canonical FROM tag_aliases WHERE alias = ?')
      .get(tag) as {canonical: string} | undefined;
    const canonical = aliasRow?.canonical ?? tag;

    const exists = deps.db
      .prepare('SELECT 1 AS x FROM tags_taxonomy WHERE tag = ?')
      .get(canonical) as {x: number} | undefined;
    if (!exists) {
      sendError(ctx.res, 404, 'tag_not_found', `tag '${tag}' is not in the taxonomy`);
      return;
    }

    const {offset, limit} = parsePagination(ctx.query);
    const records = new RecordsRepository(deps.db);

    const idRows = deps.db
      .prepare(
        `SELECT record_id FROM tags
          WHERE tag = ?
          ORDER BY record_id
          LIMIT ? OFFSET ?`
      )
      .all(canonical, limit, offset) as unknown[] as {record_id: string}[];

    const total = (
      deps.db.prepare('SELECT COUNT(*) AS n FROM tags WHERE tag = ?').get(canonical) as {n: number}
    ).n;

    const items = idRows
      .map(r => records.getById(r.record_id))
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map(r => toJsonRecord(r, {includeBody: false}));

    sendJson(ctx.res, 200, {
      tag: canonical,
      ...(canonical !== tag ? {alias_for: canonical, requested: tag} : {}),
      items,
      offset,
      limit,
      total
    });
  };
