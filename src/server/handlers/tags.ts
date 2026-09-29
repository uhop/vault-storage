import {existsSync, readFileSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
import {RecordSummaryVecRepository} from '../../db/summary-vec-repo.ts';
import {tagEmbedText} from '../../embeddings/embed-tags.ts';
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
import {
  NEAREST_K_DEFAULT,
  NEAREST_K_MAX,
  NEAREST_QUERIES_MAX,
  TagNearest,
  type NearestQuery
} from '../tag-nearest.ts';
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
  dry_run?: unknown;
}

/**
 * The preview a create answers with, and a dry run stops at: `overlaps`, the
 * nearest existing tags to the new one's name and description, `likely` when
 * the score reaches OVERLAP_SCORE or the name resolves to a tag already;
 * `reach`, the notes whose `agent.summary` vector sits within REACH_SCORE of
 * the tag's text, `tagged` for those carrying it. Calibrated 2026-09-28 on
 * croc: a paraphrased description scored its tag 0.71 to 0.73 and an
 * unrelated text 0.62 at best.
 */
export const OVERLAP_SCORE = 0.7;
export const REACH_SCORE = 0.7;
const OVERLAP_K = 5;
const REACH_K = 20;

interface OverlapItem {
  tag: string;
  description: string | null;
  score: number | null;
  matched: string[];
  likely: boolean;
}

interface ReachItem {
  record_id: string;
  file_path: string;
  title: string | null;
  score: number;
  tagged: boolean;
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

/**
 * POST /tags/nearest {text?, tags?, k?}
 * The nearest existing tags for a draft's text or for proposed tag names, so
 * a writer picks from the taxonomy and mints only when nothing fits; the
 * scoring and matching are `TagNearest`'s. Returns {queries: [{query, kind,
 * exact, items}], tag_vecs, as_of}.
 * 400 — neither text nor tags, an empty or non-string entry, or k outside 1..50.
 */
export const nearestTagsHandler = (deps: TagsDeps): Handler => {
  const nearest = new TagNearest(deps.db, deps.embedder);
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
    const queries: NearestQuery[] = [];
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
    const answer = await nearest.query(queries, k);
    sendJson(ctx.res, 200, {...answer, as_of: asOf(deps.db)});
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
export const addTaxonomyHandler = (deps: TagsDeps): Handler => {
  const nearest = new TagNearest(deps.db, deps.embedder);
  const summaries = new RecordSummaryVecRepository(deps.db);
  const carries = deps.db.prepare('SELECT 1 AS x FROM tags WHERE record_id = ? AND tag = ?');

  const overlapsOf = async (tag: string, description: string | null): Promise<OverlapItem[]> => {
    const {queries} = await nearest.query(
      [
        {query: tag, kind: 'tag'},
        {query: tagEmbedText(tag, description), kind: 'text'}
      ],
      OVERLAP_K
    );
    const merged = new Map<string, OverlapItem>();
    for (const q of queries) {
      for (const item of q.items) {
        if (item.tag === tag) continue;
        const seen = merged.get(item.tag);
        const matched = new Set([...(seen?.matched ?? []), ...item.matched]);
        const score =
          seen?.score === null || seen === undefined
            ? item.score
            : item.score === null
              ? seen.score
              : Math.max(seen.score, item.score);
        merged.set(item.tag, {
          tag: item.tag,
          description: item.description,
          score,
          matched: [...matched],
          likely: (score !== null && score >= OVERLAP_SCORE) || matched.has('exact')
        });
      }
    }
    return [...merged.values()]
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (a.tag < b.tag ? -1 : 1))
      .slice(0, OVERLAP_K);
  };

  const reachOf = async (tag: string, description: string | null): Promise<ReachItem[]> => {
    const vec = await deps.embedder.embedQuery(tagEmbedText(tag, description));
    const items: ReachItem[] = [];
    for (const hit of summaries.nearest(vec, REACH_K)) {
      const score = Number((1 - hit.distance / 2).toFixed(4));
      if (score < REACH_SCORE) continue;
      const record = deps.records.getById(hit.recordId);
      if (!record) continue;
      items.push({
        record_id: record.recordId,
        file_path: record.filePath,
        title: record.title ?? null,
        score,
        tagged: carries.get(record.recordId, tag) !== undefined
      });
    }
    return items;
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
    if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') {
      sendError(ctx.res, 400, 'bad_request', 'dry_run must be a boolean when given');
      return;
    }
    const description = typeof body.description === 'string' ? body.description : null;

    const existing = deps.db.prepare('SELECT 1 AS x FROM tags_taxonomy WHERE tag = ?').get(tag) as
      {x: number} | undefined;
    if (body.dry_run === true) {
      const [overlaps, reach] = await Promise.all([
        overlapsOf(tag, description),
        reachOf(tag, description)
      ]);
      sendJson(ctx.res, 200, {
        dry_run: true,
        tag,
        description,
        origin,
        exists: existing !== undefined,
        overlaps,
        reach: {threshold: REACH_SCORE, count: reach.length, items: reach}
      });
      return;
    }
    if (existing) {
      sendError(ctx.res, 409, 'conflict', `tag '${tag}' already in taxonomy`);
      return;
    }
    const [overlaps, reach] = await Promise.all([
      overlapsOf(tag, description),
      reachOf(tag, description)
    ]);

    const now = new Date().toISOString();
    const filer = new SuggestionFiler(deps.db, 'new_tag');

    deps.db.exec('BEGIN');
    try {
      deps.db
        .prepare('INSERT INTO tags_taxonomy (tag, description, added, origin) VALUES (?, ?, ?, ?)')
        .run(tag, description, now, origin as string);
      const {linked, accepted} = linkBackfillAndAutoAccept(
        deps.db,
        filer,
        tag,
        tag,
        'taxonomy-add',
        now
      );
      // A manual tag asks the sweep about the notes in its reach; a minted one
      // already has the notes that proposed it, linked above.
      let filed = 0;
      if (origin === 'manual') {
        const proposals = new SuggestionFiler(deps.db, 'tag_suggestion');
        for (const item of reach) {
          if (item.tagged) continue;
          const wasFiled = proposals.file(
            {
              tag,
              record_id: item.record_id,
              file_path: item.file_path,
              evidence: {source: 'vector', asserted: false}
            },
            now,
            {subjectId: item.record_id}
          );
          if (wasFiled) ++filed;
        }
      }
      deps.db.exec('COMMIT');
      sendJson(ctx.res, 200, {
        tag,
        description,
        origin,
        linked,
        accepted,
        overlaps,
        reach: {threshold: REACH_SCORE, count: reach.length, filed, items: reach}
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
