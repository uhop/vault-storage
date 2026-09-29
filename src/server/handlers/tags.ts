import {existsSync, readFileSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
import {TagVecRepository} from '../../db/tag-vec-repo.ts';
import {embedTagsPending} from '../../embeddings/embed-tags.ts';
import type {Embedder} from '../../embeddings/types.ts';
import {SuggestionFiler, type NewTagSuggestionPayload} from '../../importer/file-suggestions.ts';
import {importFile} from '../../importer/import-file.ts';
import {fullImportOptions} from '../../importer/import-options.ts';
import {dropTaxonomyTag} from '../../maintenance/gc-tags.ts';
import {parseFrontmatter} from '../../markdown/frontmatter.ts';
import type {RecordsRepository} from '../../records/repository.ts';
import {readBodyText} from '../body.ts';
import {NO_QUERY_PARAMS, parsePagination, rejectUnknownParams} from '../query.ts';
import {asOf} from '../as-of.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';
import {toJsonRecord} from '../serialize.ts';
import {ensureSafePath, writeSplitRecordToDisk, WriterError} from '../writer.ts';

interface TagsDeps {
  db: DatabaseSync;
  records: RecordsRepository;
  vaultDataPath: string;
  embedder: Embedder;
}

// Tag taxonomy CHECK constraint (see schema 0001_init.sql):
//   - lowercased, length > 0
//   - first char [a-z0-9], remaining chars [a-z0-9-]
const TAXONOMY_TAG_RE = /^[a-z0-9][a-z0-9-]*$/;
const ALIAS_RE = /^[^A-Z]+$/; // schema enforces lowercase only; permissive otherwise.

// Same convention as GET /sections: a bare column sorts descending, `_asc` ascending.
const TAG_SORTS: Record<string, string> = {
  count: 'record_count DESC, t.tag ASC',
  count_asc: 'record_count ASC, t.tag ASC',
  tag: 't.tag DESC',
  tag_asc: 't.tag ASC'
};

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

/**
 * GET /tags?prefix=&contains=&sort=&offset=&limit=
 * List managed tags with their description and per-tag record_count. `sort` is `count` (default,
 * most used first), `count_asc`, `tag` (Z to A), or `tag_asc` (A to Z).
 */
export const listTagsHandler =
  (deps: TagsDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, new Set(['prefix', 'contains', 'sort', 'offset', 'limit'])))
      return;
    const {offset, limit} = parsePagination(ctx.query);
    const sortKey = ctx.query['sort'] ?? 'count';
    const orderBy = TAG_SORTS[sortKey];
    if (orderBy === undefined) {
      sendError(
        ctx.res,
        400,
        'bad_request',
        `unknown sort: ${sortKey} (expected ${Object.keys(TAG_SORTS).join(', ')})`
      );
      return;
    }

    const where: string[] = [];
    const bindings: string[] = [];
    const prefix = ctx.query['prefix'];
    if (prefix) {
      where.push("t.tag LIKE ? ESCAPE '\\'");
      bindings.push(`${likeEscape(prefix)}%`);
    }
    const contains = ctx.query['contains'];
    if (contains) {
      where.push("t.tag LIKE ? ESCAPE '\\'");
      bindings.push(`%${likeEscape(contains)}%`);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const sql = `
      SELECT t.tag AS tag,
             t.description AS description,
             t.origin AS origin,
             COALESCE(COUNT(tags.record_id), 0) AS record_count
        FROM tags_taxonomy t
        LEFT JOIN tags ON tags.tag = t.tag
        ${whereClause}
       GROUP BY t.tag
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`;
    const countSql = `SELECT COUNT(*) AS n FROM tags_taxonomy t ${whereClause}`;

    const rows = deps.db.prepare(sql).all(...bindings, limit, offset) as unknown[] as {
      tag: string;
      description: string | null;
      origin: string;
      record_count: number;
    }[];
    const total = (deps.db.prepare(countSql).get(...bindings) as {n: number}).n;

    sendJson(ctx.res, 200, {
      items: rows.map(r => ({
        tag: r.tag,
        description: r.description,
        origin: r.origin,
        record_count: r.record_count
      })),
      offset,
      limit,
      total,
      as_of: asOf(deps.db)
    });
  };

/**
 * GET /tags/{tag}
 * Taxonomy row for one tag: description, added date, aliases, record count.
 * Accepts an alias; resolves to the canonical row.
 */
export const tagInfoHandler =
  (deps: TagsDeps): Handler =>
  ctx => {
    // Empty set, not an oversight: this endpoint reads no query params.
    if (!rejectUnknownParams(ctx, new Set())) return;
    const tag = ctx.params['tag'];
    if (!tag) {
      sendError(ctx.res, 400, 'bad_request', 'missing tag');
      return;
    }

    const aliasRow = deps.db
      .prepare('SELECT canonical FROM tag_aliases WHERE alias = ?')
      .get(tag) as {canonical: string} | undefined;
    const canonical = aliasRow?.canonical ?? tag;

    const row = deps.db
      .prepare('SELECT tag, description, added, origin FROM tags_taxonomy WHERE tag = ?')
      .get(canonical) as
      {tag: string; description: string | null; added: string | null; origin: string} | undefined;
    if (!row) {
      sendError(ctx.res, 404, 'tag_not_found', `tag '${tag}' is not in the taxonomy`);
      return;
    }

    const aliases = (
      deps.db
        .prepare('SELECT alias FROM tag_aliases WHERE canonical = ? ORDER BY alias')
        .all(canonical) as unknown[] as {alias: string}[]
    ).map(r => r.alias);
    const recordCount = (
      deps.db.prepare('SELECT COUNT(*) AS n FROM tags WHERE tag = ?').get(canonical) as {n: number}
    ).n;

    sendJson(ctx.res, 200, {
      tag: row.tag,
      ...(canonical !== tag ? {requested: tag} : {}),
      description: row.description,
      added: row.added,
      origin: row.origin,
      aliases,
      record_count: recordCount
    });
  };

/**
 * GET /tags/{tag}/records?offset=&limit=
 * List records carrying the given tag, most recently updated first. Same
 * envelope as `/sections`.
 */
export const recordsByTagHandler =
  (deps: TagsDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, new Set(['offset', 'limit']))) return;
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
        `SELECT tags.record_id AS record_id
           FROM tags
           JOIN records r ON r.record_id = tags.record_id
          WHERE tags.tag = ?
          ORDER BY r.updated DESC, tags.record_id
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
      total,
      as_of: asOf(deps.db)
    });
  };

interface AddTaxonomyBody {
  tag?: string;
  description?: string;
  origin?: unknown;
}

const ADDABLE_ORIGINS: ReadonlySet<unknown> = new Set(['manual', 'minted']);

interface UpdateTaxonomyBody {
  description?: unknown;
  origin?: unknown;
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
          AND status IN ('pending', 'claimed')
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

interface NearestBody {
  text?: unknown;
  tags?: unknown;
  k?: unknown;
}

type Matched = 'exact' | 'alias' | 'name' | 'embedding';

interface NearestCandidate {
  score: number | null;
  matched: Set<Matched>;
}

const NEAREST_K_DEFAULT = 12;
const NEAREST_K_MAX = 50;
const NEAREST_QUERIES_MAX = 50;
const NAME_WORD_MIN = 3;

/** A proposed name in taxonomy form: lowercase, words joined by hyphens. */
const tagForm = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');

/** The same scale as /similar: 1 for an identical vector, from the L2 distance of unit vectors. */
const scoreOfDistance = (distance: number): number => Number((1 - distance / 2).toFixed(4));

const distanceBetween = (a: Float32Array, b: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; ++i) {
    const d = a[i]! - (b[i] ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
};

/**
 * POST /tags/nearest {text?, tags?, k?}
 * The nearest existing tags for a draft's text or for proposed tag names, so
 * a writer picks from the taxonomy and mints only when nothing fits. Every
 * query is scored against the embedding of each tag's name and description;
 * a name is also matched exactly (canonical or alias, ranked first) and by
 * its words against tag names and aliases, and those hits are scored from
 * their stored vector. The tag vectors are refreshed on the way in, so a tag
 * added or re-described since the last call is embedded here.
 *
 * Returns {queries: [{query, kind, exact, items}], tag_vecs, as_of}.
 * 400 — neither text nor tags, an empty or non-string entry, or k outside 1..50.
 */
export const nearestTagsHandler = (deps: TagsDeps): Handler => {
  const {db} = deps;
  const canonicalOf = db.prepare('SELECT tag FROM tags_taxonomy WHERE tag = ?');
  const aliasOf = db.prepare('SELECT canonical FROM tag_aliases WHERE alias = ?');
  const tagsLike = db.prepare(
    `SELECT tag FROM tags_taxonomy WHERE tag LIKE ? ESCAPE '\\' ORDER BY tag LIMIT ${NEAREST_K_MAX}`
  );
  const aliasesLike = db.prepare(
    `SELECT canonical FROM tag_aliases WHERE alias LIKE ? ESCAPE '\\' ORDER BY alias LIMIT ${NEAREST_K_MAX}`
  );
  const detail = db.prepare(
    `SELECT t.tag, t.description, t.origin,
            (SELECT COUNT(*) FROM tags WHERE tags.tag = t.tag) AS record_count
       FROM tags_taxonomy t WHERE t.tag = ?`
  );
  const vecs = new TagVecRepository(db);

  const nameHits = (needle: string): {tag: string; how: Matched}[] => {
    const words = new Set([needle, ...needle.split('-').filter(w => w.length >= NAME_WORD_MIN)]);
    const hits: {tag: string; how: Matched}[] = [];
    for (const word of words) {
      const pattern = `%${likeEscape(word)}%`;
      for (const r of tagsLike.all(pattern) as unknown[] as {tag: string}[]) {
        hits.push({tag: r.tag, how: 'name'});
      }
      for (const r of aliasesLike.all(pattern) as unknown[] as {canonical: string}[]) {
        hits.push({tag: r.canonical, how: 'alias'});
      }
    }
    return hits;
  };

  return async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }
    const body = await parseJsonObject<NearestBody>(raw);
    if (typeof body === 'string') {
      sendError(ctx.res, 400, 'bad_request', body);
      return;
    }
    const queries: {query: string; kind: 'text' | 'tag'}[] = [];
    if ('text' in body) {
      if (typeof body.text !== 'string' || body.text.trim().length === 0) {
        sendError(ctx.res, 400, 'bad_request', 'text must be a non-empty string');
        return;
      }
      queries.push({query: body.text, kind: 'text'});
    }
    if ('tags' in body) {
      const tags = body.tags;
      const wellFormed =
        Array.isArray(tags) &&
        tags.length > 0 &&
        tags.every(t => typeof t === 'string' && t.trim().length > 0);
      if (!wellFormed) {
        sendError(
          ctx.res,
          400,
          'bad_request',
          'tags must be a non-empty array of non-empty strings'
        );
        return;
      }
      for (const t of tags as string[]) queries.push({query: t, kind: 'tag'});
    }
    if (queries.length === 0) {
      sendError(ctx.res, 400, 'bad_request', 'give text, tags, or both');
      return;
    }
    if (queries.length > NEAREST_QUERIES_MAX) {
      sendError(ctx.res, 400, 'bad_request', `at most ${NEAREST_QUERIES_MAX} queries per call`);
      return;
    }
    let k = NEAREST_K_DEFAULT;
    if ('k' in body) {
      const given = body.k;
      if (
        typeof given !== 'number' ||
        !Number.isInteger(given) ||
        given < 1 ||
        given > NEAREST_K_MAX
      ) {
        sendError(ctx.res, 400, 'bad_request', `k must be an integer from 1 to ${NEAREST_K_MAX}`);
        return;
      }
      k = given;
    }

    const tagVecs = await embedTagsPending(db, deps.embedder);

    const results = [];
    for (const {query, kind} of queries) {
      const found = new Map<string, NearestCandidate>();
      const add = (tag: string, how: Matched, score: number | null): void => {
        let entry = found.get(tag);
        if (!entry) {
          entry = {score: null, matched: new Set()};
          found.set(tag, entry);
        }
        entry.matched.add(how);
        if (score !== null) entry.score = score;
      };

      let exact: {tag: string; requested?: string} | null = null;
      let embedInput = query;
      if (kind === 'tag') {
        const needle = tagForm(query);
        embedInput = needle.replace(/-+/g, ' ');
        const canonical = canonicalOf.get(needle) as {tag: string} | undefined;
        const alias = aliasOf.get(needle) as {canonical: string} | undefined;
        if (canonical) {
          exact = {tag: canonical.tag};
          add(canonical.tag, 'exact', null);
        } else if (alias) {
          exact = {tag: alias.canonical, requested: needle};
          add(alias.canonical, 'exact', null);
        }
        for (const hit of nameHits(needle)) add(hit.tag, hit.how, null);
      }

      const qvec = await deps.embedder.embedQuery(embedInput);
      for (const hit of vecs.nearest(qvec, k)) {
        add(hit.tag, 'embedding', scoreOfDistance(hit.distance));
      }
      for (const [tag, entry] of found) {
        if (entry.score !== null) continue;
        const stored = vecs.get(tag);
        if (stored) entry.score = scoreOfDistance(distanceBetween(qvec, stored));
      }

      // An exact hit is the answer whatever its vector says; then best score first.
      const ranked = [...found.entries()]
        .sort(([tagA, a], [tagB, b]) => {
          const exactA = a.matched.has('exact');
          if (exactA !== b.matched.has('exact')) return exactA ? -1 : 1;
          if (a.score === b.score) return tagA < tagB ? -1 : tagA > tagB ? 1 : 0;
          if (a.score === null) return 1;
          if (b.score === null) return -1;
          return b.score - a.score;
        })
        .slice(0, k);

      const items = [];
      for (const [tag, entry] of ranked) {
        const row = detail.get(tag) as
          | {tag: string; description: string | null; origin: string; record_count: number}
          | undefined;
        if (!row) continue;
        items.push({
          tag: row.tag,
          description: row.description,
          origin: row.origin,
          record_count: row.record_count,
          score: entry.score,
          matched: [...entry.matched]
        });
      }
      results.push({query, kind, exact, items});
    }

    sendJson(ctx.res, 200, {
      queries: results,
      tag_vecs: {embedded: tagVecs.embedded, up_to_date: tagVecs.upToDate, total: tagVecs.total},
      as_of: asOf(db)
    });
  };
};

/**
 * POST /tags/taxonomy {tag, description?, origin?}
 * Add a canonical tag to `tags_taxonomy`. `origin` is `manual` for a tag
 * created on purpose, which the empty-tag collection keeps, or `minted`, the
 * default (D77). Auto-links the new tag to records
 * that had it rejected (via pending `new_tag` suggestions) and resolves
 * those suggestions as `accepted` with `resolved_by='taxonomy-add'`.
 *
 * 400 — invalid tag shape (must match `[a-z0-9][a-z0-9-]*`).
 * 409 — tag already in taxonomy.
 */
export const addTaxonomyHandler =
  (deps: TagsDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
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

    const origin = body.origin ?? 'minted';
    if (!ADDABLE_ORIGINS.has(origin)) {
      sendError(ctx.res, 400, 'bad_request', 'origin must be "manual" or "minted"');
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
        .prepare('INSERT INTO tags_taxonomy (tag, description, added, origin) VALUES (?, ?, ?, ?)')
        .run(tag, body.description ?? null, now, origin as string);
      const {linked, accepted} = linkBackfillAndAutoAccept(
        deps.db,
        filer,
        tag,
        tag,
        'taxonomy-add',
        now
      );
      deps.db.exec('COMMIT');
      sendJson(ctx.res, 200, {
        tag,
        description: body.description ?? null,
        origin,
        linked,
        accepted
      });
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
 * PATCH /tags/taxonomy/{tag} {description?, origin?}
 * Rewrite a canonical tag's description, the one field a mint leaves
 * permanent otherwise (an alias that broadens what the tag covers had no
 * route to say so, 2026-09-16); `null` clears it. `origin` re-labels the tag
 * `manual` (kept by the empty-tag collection) or `minted` (D77). At least one
 * of the two; nothing else on the row moves. An alias is not a row: 404.
 *
 * 400 — neither field given, a description neither a string nor null, or an
 *       origin other than manual or minted.
 * 404 — tag not in the taxonomy.
 */
export const updateTaxonomyHandler =
  (deps: TagsDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const tag = ctx.params['tag'];
    if (!tag) {
      sendError(ctx.res, 400, 'bad_request', 'missing tag');
      return;
    }
    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }
    const body = await parseJsonObject<UpdateTaxonomyBody>(raw);
    if (typeof body === 'string') {
      sendError(ctx.res, 400, 'bad_request', body);
      return;
    }
    const hasDescription = 'description' in body;
    const hasOrigin = 'origin' in body;
    if (!hasDescription && !hasOrigin) {
      sendError(ctx.res, 400, 'bad_request', 'give description, origin, or both');
      return;
    }
    const {description, origin} = body;
    if (hasDescription && description !== null && typeof description !== 'string') {
      sendError(ctx.res, 400, 'bad_request', 'description must be a string, or null to clear it');
      return;
    }
    if (hasOrigin && !ADDABLE_ORIGINS.has(origin)) {
      sendError(ctx.res, 400, 'bad_request', 'origin must be "manual" or "minted"');
      return;
    }
    const sets = [
      ...(hasDescription ? ['description = ?'] : []),
      ...(hasOrigin ? ['origin = ?'] : [])
    ];
    const values = [
      ...(hasDescription ? [description as string | null] : []),
      ...(hasOrigin ? [origin as string] : [])
    ];
    const result = deps.db
      .prepare(`UPDATE tags_taxonomy SET ${sets.join(', ')} WHERE tag = ?`)
      .run(...values, tag);
    if (Number(result.changes) === 0) {
      sendError(ctx.res, 404, 'tag_not_found', `tag '${tag}' is not in the taxonomy`);
      return;
    }
    sendJson(ctx.res, 200, {
      tag,
      ...(hasDescription ? {description} : {}),
      ...(hasOrigin ? {origin} : {})
    });
  };

/**
 * DELETE /tags/taxonomy/{tag}
 * Delete a canonical tag outright (D77): strip it, and every alias of it, from
 * the `tags:` of each record that carries it, writing and re-importing each
 * one, then drop its aliases and its row and reject the pending suggestions
 * proposing it. Mechanical, with no agent; the tags page asks first, showing
 * the record count. An alias is not a row: 404.
 *
 * Returns {tag, records_stripped, aliases_dropped, suggestions_rejected}.
 */
export const deleteTaxonomyHandler =
  (deps: TagsDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const tag = ctx.params['tag'];
    if (!tag) {
      sendError(ctx.res, 400, 'bad_request', 'missing tag');
      return;
    }
    const {db, records} = deps;
    if (!db.prepare('SELECT 1 AS x FROM tags_taxonomy WHERE tag = ?').get(tag)) {
      sendError(ctx.res, 404, 'tag_not_found', `tag '${tag}' is not in the taxonomy`);
      return;
    }
    const forms = new Set([
      tag,
      ...(
        db.prepare('SELECT alias FROM tag_aliases WHERE canonical = ?').all(tag) as {
          alias: string;
        }[]
      ).map(r => r.alias)
    ]);
    const ids = (
      db.prepare('SELECT record_id FROM tags WHERE tag = ?').all(tag) as {record_id: string}[]
    ).map(r => r.record_id);

    let stripped = 0;
    for (const id of ids) {
      const record = records.getById(id);
      if (!record) continue;
      try {
        const abs = ensureSafePath(deps.vaultDataPath, record.filePath);
        if (!existsSync(abs)) continue;
        const {data, body} = parseFrontmatter(readFileSync(abs, 'utf8'));
        const current = Array.isArray(data['tags']) ? (data['tags'] as unknown[]) : [];
        const kept = current.filter(t => typeof t !== 'string' || !forms.has(t));
        if (kept.length !== current.length) {
          writeSplitRecordToDisk({
            filePath: record.filePath,
            existing: record,
            frontmatter: {tags: kept},
            body,
            vaultDataPath: deps.vaultDataPath
          });
          ++stripped;
        }
        importFile(records, record.filePath, abs, undefined, fullImportOptions(db));
      } catch (err) {
        if (err instanceof WriterError) {
          sendError(ctx.res, err.status, err.code, err.message, {
            ...err.details,
            file_path: record.filePath,
            records_stripped: stripped
          });
          return;
        }
        throw err;
      }
    }

    db.exec('BEGIN');
    let dropped: {aliases: number; suggestions: number};
    try {
      db.prepare('DELETE FROM tags WHERE tag = ?').run(tag);
      dropped = dropTaxonomyTag(db, tag, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    sendJson(ctx.res, 200, {
      tag,
      records_stripped: stripped,
      aliases_dropped: dropped.aliases,
      suggestions_rejected: dropped.suggestions
    });
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
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
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
