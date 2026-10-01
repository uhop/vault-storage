import type {DatabaseSync} from 'node:sqlite';
import {RecordVecRepository} from '../../db/vec-repo.ts';
import type {Embedder} from '../../embeddings/types.ts';
import {rejectUnknownParams} from '../query.ts';
import {asOf, asOfHeaders} from '../as-of.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';
import {prepared} from '../../db/prepared.ts';
import {
  edgeFacets,
  edgeFilterSql,
  edgesOf,
  parseEdgeFilter,
  type EdgeCondition
} from '../edge-filter.ts';

interface SearchDeps {
  db: DatabaseSync;
  embedder: Embedder;
}

interface MatchSpan {
  match: {start: number; end: number};
  context: string;
}

interface SearchHit {
  filename: string;
  score: number;
  matches: MatchSpan[];
  record_id: string;
}

const CONTEXT_PAD = 40;
const MAX_MATCHES_PER_FILE = 5;

const findMatches = (haystack: string, needle: string): MatchSpan[] => {
  const out: MatchSpan[] = [];
  if (needle.length === 0) return out;
  const lowerH = haystack.toLowerCase();
  const lowerN = needle.toLowerCase();
  let from = 0;
  while (out.length < MAX_MATCHES_PER_FILE) {
    const at = lowerH.indexOf(lowerN, from);
    if (at < 0) break;
    const start = Math.max(0, at - CONTEXT_PAD);
    const end = Math.min(haystack.length, at + needle.length + CONTEXT_PAD);
    out.push({
      match: {start: at, end: at + needle.length},
      context: haystack.slice(start, end)
    });
    from = at + needle.length;
  }
  return out;
};

// Build a safe FTS5 MATCH from a free-text query. Each whitespace term is
// double-quoted (neutralizes FTS5 operators / special chars in user input)
// and given a trailing `*` for prefix matching; space-separated terms AND in
// FTS5, so every term must be present. Pure-punctuation terms are dropped —
// they tokenize to nothing and would make a zero-token phrase.
const HAS_TOKEN = /[\p{L}\p{N}]/u;

/** Free-text query → searchable terms (pure-punctuation terms dropped). */
export const queryTerms = (query: string): string[] =>
  query.split(/\s+/).filter(t => t.length > 0 && HAS_TOKEN.test(t));

const buildMatch = (query: string): {match: string; terms: string[]} | null => {
  const terms = queryTerms(query);
  if (terms.length === 0) return null;
  const match = terms.map(t => `"${t.replace(/"/g, '""')}"*`).join(' ');
  return {match, terms};
};

interface FtsRow {
  rid: number;
  record_id: string;
  file_path: string;
  title: string | null;
  rank: number;
}

// Title hits add a full point on top of the (0,1) body relevance, so a
// title match always outranks a body-only one regardless of corpus stats.
const TITLE_BOOST = 1;

export const lexicalSearch = (
  db: DatabaseSync,
  query: string,
  limit: number,
  conditions: readonly EdgeCondition[] = []
): SearchHit[] => {
  const built = buildMatch(query);
  if (!built) return [];
  const filter = edgeFilterSql(conditions, 'r.record_id');

  // Indexed FTS5 MATCH replaces the O(rows) LIKE scan. Fetch ALL matches (no
  // SQL LIMIT) and rank in JS, so a title match with weak bm25 can't be sliced
  // off before scoring — the property the "scores all before limit" test pins.
  // Bodies are read for the kept hits only: the score never uses them (D120).
  let rows: FtsRow[];
  try {
    rows = prepared(
      db,
      `SELECT r.rowid AS rid, r.record_id, r.file_path, r.title, bm25(records_fts) AS rank
           FROM records_fts
           JOIN records r ON r.rowid = records_fts.rowid
          WHERE records_fts MATCH ?${filter.sql ? ` AND ${filter.sql}` : ''}`
    ).all(built.match, ...filter.params) as unknown[] as FtsRow[];
  } catch {
    // Defensive: any residual FTS5 query-syntax error degrades to no results
    // rather than a 500. Quoting already neutralizes operators.
    return [];
  }

  const terms = built.terms.map(t => t.toLowerCase());
  const ranked = rows
    .map(row => {
      const title = row.title?.toLowerCase() ?? '';
      const titleHits = terms.filter(term => title.includes(term)).length;
      // bm25 (`rank`) is unbounded, negative-is-better, and turns positive for
      // corpus-ubiquitous terms (negative idf) — a logistic tames it to a (0,1)
      // relevance (same scale as semanticSearch). The title boost layered on top
      // is the deterministic field preference bm25's idf can't guarantee in
      // small/dense corpora.
      const relevance = 1 / (1 + Math.exp(row.rank));
      return {row, score: Number((titleHits * TITLE_BOOST + relevance).toFixed(4))};
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  // Context spans come from the body via the same substring scan as before, so
  // the {match:{start,end}, context} output contract is unchanged.
  const bodyOf = prepared(db, 'SELECT body FROM records WHERE rowid = ?');
  return ranked.map(({row, score}) => {
    const body = (bodyOf.get(row.rid) as {body: string} | undefined)?.body ?? '';
    const matches: MatchSpan[] = [];
    for (const term of built.terms) {
      for (const m of findMatches(body, term)) {
        if (matches.length < MAX_MATCHES_PER_FILE) matches.push(m);
      }
    }
    return {filename: row.file_path, score, matches, record_id: row.record_id};
  });
};

/** How many nearest records a filtered semantic search reads per hit it may answer, and at most. */
const EDGE_WINDOW_FACTOR = 5;
const EDGE_WINDOW_MAX = 500;

/** The hits, and how many nearest records were read when a filter left fewer than `limit` of a full window. */
const semanticSearch = async (
  db: DatabaseSync,
  embedder: Embedder,
  query: string,
  limit: number,
  conditions: readonly EdgeCondition[] = []
): Promise<{hits: SearchHit[]; window: number | null}> => {
  const vec = await embedder.embedQuery(query);
  const repo = new RecordVecRepository(db);
  const window = conditions.length ? Math.min(EDGE_WINDOW_MAX, limit * EDGE_WINDOW_FACTOR) : limit;
  const near = await repo.nearest(vec, window);
  if (near.length === 0) return {hits: [], window: null};

  const filter = edgeFilterSql(conditions, 'r.record_id');
  const rows = prepared(
    db,
    `SELECT r.record_id, r.file_path FROM records r
      WHERE r.record_id IN (SELECT value FROM json_each(?))${filter.sql ? ` AND ${filter.sql}` : ''}`
  ).all(JSON.stringify(near.map(h => h.recordId)), ...filter.params) as unknown[] as {
    record_id: string;
    file_path: string;
  }[];
  const pathById = new Map(rows.map(r => [r.record_id, r.file_path]));

  const hits = near
    .filter(h => pathById.has(h.recordId))
    .slice(0, limit)
    .map(h => ({
      filename: pathById.get(h.recordId)!,
      score: Number((1 - h.distance / 2).toFixed(4)),
      matches: [],
      record_id: h.recordId
    }));
  const short = conditions.length > 0 && hits.length < limit && near.length >= window;
  return {hits, window: short ? window : null};
};

/**
 * POST /search/simple/?query=...&mode=lexical|semantic&limit=N&edge=...&edges=1:
 * `edge` keeps the hits whose edges meet every condition (D129), `edges=1`
 * adds each hit's record id and edges.
 */
export const simpleSearchHandler =
  (deps: SearchDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, new Set(['query', 'mode', 'limit', 'edge', 'edges']))) return;
    const query = ctx.query['query'];
    if (!query || query.length === 0) {
      sendError(ctx.res, 400, 'bad_request', 'missing query parameter');
      return;
    }

    const mode = ctx.query['mode'] ?? 'lexical';
    if (mode !== 'lexical' && mode !== 'semantic') {
      sendError(ctx.res, 400, 'bad_request', `unknown mode: ${mode}`);
      return;
    }

    const limitRaw = ctx.query['limit'];
    const limit = Math.min(100, Math.max(1, limitRaw ? Number.parseInt(limitRaw, 10) || 20 : 20));

    let conditions: EdgeCondition[] = [];
    if (ctx.query['edge'] !== undefined) {
      try {
        conditions = parseEdgeFilter(ctx.query['edge']);
      } catch (err) {
        sendError(ctx.res, 400, 'bad_request', (err as Error).message);
        return;
      }
    }
    const withEdges = ctx.query['edges'];
    if (withEdges !== undefined && withEdges !== '1' && withEdges !== '0') {
      sendError(ctx.res, 400, 'bad_request', 'edges must be 1 or 0');
      return;
    }

    const {hits, window} =
      mode === 'semantic'
        ? await semanticSearch(deps.db, deps.embedder, query, limit, conditions)
        : {hits: lexicalSearch(deps.db, query, limit, conditions), window: null};

    const edges =
      withEdges === '1'
        ? edgesOf(
            deps.db,
            hits.map(h => h.record_id)
          )
        : null;
    const body = hits.map(({record_id, ...hit}) =>
      edges ? {...hit, record_id, edges: edges.get(record_id) ?? []} : hit
    );
    // A bare array carries no keys, so the stamp rides in headers here.
    const headers = asOfHeaders(asOf(deps.db));
    if (window !== null) headers['X-Vault-Edge-Window'] = String(window);
    sendJson(ctx.res, 200, body, headers);
  };

/** Every record the lexical query matches, unranked; none for a query FTS5 cannot read. */
const lexicalIds = (db: DatabaseSync, query: string): string[] => {
  const built = buildMatch(query);
  if (!built) return [];
  try {
    return (
      prepared(
        db,
        `SELECT r.record_id FROM records_fts JOIN records r ON r.rowid = records_fts.rowid
          WHERE records_fts MATCH ?`
      ).all(built.match) as unknown[] as {record_id: string}[]
    ).map(r => r.record_id);
  } catch {
    return [];
  }
};

/** How many nearest records a semantic facet counts over: the filter's window at the page's 20 hits. */
const FACET_WINDOW = 100;

/**
 * POST /search/facets?query=...&mode=lexical|semantic: `{total, edges: [{type,
 * direction, hits}]}` over the records an `edge=` filter would test, every
 * match in lexical mode and the FACET_WINDOW nearest in semantic mode (D130).
 */
export const searchFacetsHandler =
  (deps: SearchDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, new Set(['query', 'mode']))) return;
    const query = ctx.query['query'];
    if (!query) {
      sendError(ctx.res, 400, 'bad_request', 'missing query parameter');
      return;
    }
    const mode = ctx.query['mode'] ?? 'lexical';
    if (mode !== 'lexical' && mode !== 'semantic') {
      sendError(ctx.res, 400, 'bad_request', `unknown mode: ${mode}`);
      return;
    }
    let ids: string[];
    if (mode === 'semantic') {
      const near = await new RecordVecRepository(deps.db).nearest(
        await deps.embedder.embedQuery(query),
        FACET_WINDOW
      );
      ids = near.map(h => h.recordId);
    } else {
      ids = lexicalIds(deps.db, query);
    }
    sendJson(
      ctx.res,
      200,
      {total: ids.length, edges: edgeFacets(deps.db, ids)},
      asOfHeaders(asOf(deps.db))
    );
  };
