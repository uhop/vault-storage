import type {DatabaseSync} from 'node:sqlite';
import {SuggestionFiler, type NewTagSuggestionPayload} from '../../importer/file-suggestions.ts';
import type {RecordsRepository} from '../../records/repository.ts';
import {readBodyText} from '../body.ts';
import {parsePagination} from '../query.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';
import {toJsonRecord} from '../serialize.ts';

interface TagsDeps {
  db: DatabaseSync;
  records: RecordsRepository;
}

// Tag taxonomy CHECK constraint (see schema 0001_init.sql):
//   - lowercased, length > 0
//   - first char [a-z0-9], remaining chars [a-z0-9-]
const TAXONOMY_TAG_RE = /^[a-z0-9][a-z0-9-]*$/;
const ALIAS_RE = /^[^A-Z]+$/; // schema enforces lowercase only; permissive otherwise.

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
    const {records} = deps;

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

interface AddTaxonomyBody {
  tag?: string;
  description?: string;
}

interface AddAliasBody {
  alias?: string;
  canonical?: string;
}

const parseJsonObject = async <T>(raw: string): Promise<T | string> => {
  if (raw.trim().length === 0) return 'request body required';
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'request body must be a JSON object';
    }
    return parsed as T;
  } catch (err) {
    return `invalid JSON: ${(err as Error).message}`;
  }
};

const linkBackfillAndAutoAccept = (
  db: DatabaseSync,
  filer: SuggestionFiler<'new_tag'>,
  pendingTag: string,
  canonical: string,
  resolvedBy: 'taxonomy-add' | 'alias-add',
  now: string
): {linked: number; accepted: number} => {
  // Pull every pending new_tag suggestion for this tag-as-rejected. Each
  // carries the record_id where the tag was originally typed; INSERT OR
  // IGNORE the canonical tag on that record so the link materializes
  // immediately rather than waiting for the next per-record reindex.
  const pending = db
    .prepare(
      `SELECT payload FROM suggestions
        WHERE kind = 'new_tag'
          AND status = 'pending'
          AND json_extract(payload, '$.tag') = ?`
    )
    .all(pendingTag) as Array<{payload: string}>;
  const linkInsert = db.prepare('INSERT OR IGNORE INTO tags (record_id, tag) VALUES (?, ?)');
  let linked = 0;
  for (const row of pending) {
    let parsed: NewTagSuggestionPayload;
    try {
      parsed = JSON.parse(row.payload) as NewTagSuggestionPayload;
    } catch {
      continue;
    }
    if (typeof parsed.record_id !== 'string') continue;
    const result = linkInsert.run(parsed.record_id, canonical);
    if (Number(result.changes) > 0) linked++;
  }
  const accepted = filer.accept({tag: pendingTag}, resolvedBy, now);
  return {linked, accepted};
};

/**
 * POST /tags/taxonomy {tag, description?}
 * Add a canonical tag to `tags_taxonomy`. Auto-links the new tag to records
 * that had it rejected (via pending `new_tag` suggestions) and resolves
 * those suggestions as `accepted` with `resolved_by='taxonomy-add'`.
 *
 * 400 — invalid tag shape (must match `[a-z0-9][a-z0-9-]*`).
 * 409 — tag already in taxonomy.
 */
export const addTaxonomyHandler =
  (deps: TagsDeps): Handler =>
  async ctx => {
    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }
    const body = await parseJsonObject<AddTaxonomyBody>(raw);
    if (typeof body === 'string') {
      sendError(ctx.res, 400, 'bad_request', body);
      return;
    }
    const tag = body.tag;
    if (typeof tag !== 'string' || tag.length === 0) {
      sendError(ctx.res, 400, 'bad_request', 'tag is required');
      return;
    }
    if (!TAXONOMY_TAG_RE.test(tag)) {
      sendError(
        ctx.res,
        400,
        'bad_request',
        'tag must match /^[a-z0-9][a-z0-9-]*$/ (lowercase, alphanumeric + hyphens)'
      );
      return;
    }

    const existing = deps.db.prepare('SELECT 1 AS x FROM tags_taxonomy WHERE tag = ?').get(tag) as
      {x: number} | undefined;
    if (existing) {
      sendError(ctx.res, 409, 'conflict', `tag '${tag}' already in taxonomy`);
      return;
    }

    const now = new Date().toISOString();
    const filer = new SuggestionFiler(deps.db, 'new_tag');

    deps.db.exec('BEGIN');
    try {
      deps.db
        .prepare('INSERT INTO tags_taxonomy (tag, description, added) VALUES (?, ?, ?)')
        .run(tag, body.description ?? null, now);
      const {linked, accepted} = linkBackfillAndAutoAccept(
        deps.db,
        filer,
        tag,
        tag,
        'taxonomy-add',
        now
      );
      deps.db.exec('COMMIT');
      sendJson(ctx.res, 200, {tag, description: body.description ?? null, linked, accepted});
    } catch (err) {
      deps.db.exec('ROLLBACK');
      sendError(
        ctx.res,
        500,
        'internal',
        `failed to add taxonomy entry: ${(err as Error).message}`
      );
    }
  };

/**
 * POST /tags/aliases {alias, canonical}
 * Add an alias of an existing canonical tag. Auto-links records that had
 * the alias rejected and resolves matching pending suggestions as
 * `accepted` with `resolved_by='alias-add'`.
 *
 * 400 — invalid alias or missing canonical.
 * 404 — canonical not in taxonomy.
 * 409 — alias already exists.
 */
export const addAliasHandler =
  (deps: TagsDeps): Handler =>
  async ctx => {
    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }
    const body = await parseJsonObject<AddAliasBody>(raw);
    if (typeof body === 'string') {
      sendError(ctx.res, 400, 'bad_request', body);
      return;
    }
    const alias = body.alias;
    const canonical = body.canonical;
    if (typeof alias !== 'string' || alias.length === 0) {
      sendError(ctx.res, 400, 'bad_request', 'alias is required');
      return;
    }
    if (!ALIAS_RE.test(alias)) {
      sendError(ctx.res, 400, 'bad_request', 'alias must be lowercase');
      return;
    }
    if (typeof canonical !== 'string' || canonical.length === 0) {
      sendError(ctx.res, 400, 'bad_request', 'canonical is required');
      return;
    }

    const canonicalRow = deps.db
      .prepare('SELECT 1 AS x FROM tags_taxonomy WHERE tag = ?')
      .get(canonical) as {x: number} | undefined;
    if (!canonicalRow) {
      sendError(ctx.res, 404, 'tag_not_found', `canonical '${canonical}' is not in the taxonomy`);
      return;
    }

    const existing = deps.db
      .prepare('SELECT canonical FROM tag_aliases WHERE alias = ?')
      .get(alias) as {canonical: string} | undefined;
    if (existing) {
      sendError(
        ctx.res,
        409,
        'conflict',
        `alias '${alias}' already exists (→ '${existing.canonical}')`
      );
      return;
    }

    const now = new Date().toISOString();
    const filer = new SuggestionFiler(deps.db, 'new_tag');

    deps.db.exec('BEGIN');
    try {
      deps.db
        .prepare('INSERT INTO tag_aliases (alias, canonical) VALUES (?, ?)')
        .run(alias, canonical);
      const {linked, accepted} = linkBackfillAndAutoAccept(
        deps.db,
        filer,
        alias,
        canonical,
        'alias-add',
        now
      );
      deps.db.exec('COMMIT');
      sendJson(ctx.res, 200, {alias, canonical, linked, accepted});
    } catch (err) {
      deps.db.exec('ROLLBACK');
      sendError(ctx.res, 500, 'internal', `failed to add alias: ${(err as Error).message}`);
    }
  };
