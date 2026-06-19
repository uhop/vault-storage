import type {DatabaseSync} from 'node:sqlite';
import {RecordVecRepository} from '../../db/vec-repo.ts';
import type {Embedder} from '../../embeddings/types.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

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

const buildMatch = (query: string): {match: string; terms: string[]} | null => {
  const terms = query.split(/\s+/).filter(t => t.length > 0 && HAS_TOKEN.test(t));
  if (terms.length === 0) return null;
  const match = terms.map(t => `"${t.replace(/"/g, '""')}"*`).join(' ');
  return {match, terms};
};

interface FtsRow {
  file_path: string;
  body: string;
  title: string | null;
  rank: number;
}

// Title hits add a full point on top of the (0,1) body relevance, so a
// title match always outranks a body-only one regardless of corpus stats.
const TITLE_BOOST = 1;

const lexicalSearch = (db: DatabaseSync, query: string, limit: number): SearchHit[] => {
  const built = buildMatch(query);
  if (!built) return [];

  // Indexed FTS5 MATCH replaces the O(rows) LIKE scan. Fetch ALL matches (no
  // SQL LIMIT) and rank in JS, so a title match with weak bm25 can't be sliced
  // off before scoring — the property the "scores all before limit" test pins.
  let rows: FtsRow[];
  try {
    rows = db
      .prepare(
        `SELECT r.file_path, r.body, r.title, bm25(records_fts) AS rank
           FROM records_fts
           JOIN records r ON r.rowid = records_fts.rowid
          WHERE records_fts MATCH ?`
      )
      .all(built.match) as unknown[] as FtsRow[];
  } catch {
    // Defensive: any residual FTS5 query-syntax error degrades to no results
    // rather than a 500. Quoting already neutralizes operators.
    return [];
  }

  // Context spans come from the body via the same substring scan as before, so
  // the {match:{start,end}, context} output contract is unchanged.
  const hits: SearchHit[] = [];
  for (const row of rows) {
    const matches: MatchSpan[] = [];
    let titleHits = 0;
    for (const term of built.terms) {
      if (row.title && findMatches(row.title, term).length > 0) ++titleHits;
      for (const m of findMatches(row.body, term)) {
        if (matches.length < MAX_MATCHES_PER_FILE) matches.push(m);
      }
    }
    // bm25 (`rank`) is unbounded, negative-is-better, and turns positive for
    // corpus-ubiquitous terms (negative idf) — a logistic tames it to a (0,1)
    // relevance (same scale as semanticSearch). The title boost layered on top
    // is the deterministic field preference bm25's idf can't guarantee in
    // small/dense corpora.
    const relevance = 1 / (1 + Math.exp(row.rank));
    hits.push({
      filename: row.file_path,
      score: Number((titleHits * TITLE_BOOST + relevance).toFixed(4)),
      matches
    });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
};

const semanticSearch = async (
  db: DatabaseSync,
  embedder: Embedder,
  query: string,
  limit: number
): Promise<SearchHit[]> => {
  const vec = await embedder.embed(query);
  const repo = new RecordVecRepository(db);
  const hits = repo.nearest(vec, limit);
  if (hits.length === 0) return [];

  const ids = hits.map(h => h.recordId);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT record_id, file_path FROM records WHERE record_id IN (${placeholders})`)
    .all(...ids) as unknown[] as {record_id: string; file_path: string}[];
  const pathById = new Map(rows.map(r => [r.record_id, r.file_path]));

  return hits
    .filter(h => pathById.has(h.recordId))
    .map(h => ({
      filename: pathById.get(h.recordId)!,
      score: Number((1 - h.distance / 2).toFixed(4)),
      matches: []
    }));
};

/** POST /search/simple/?query=...&mode=lexical|semantic&limit=N */
export const simpleSearchHandler =
  (deps: SearchDeps): Handler =>
  async ctx => {
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

    const hits =
      mode === 'semantic'
        ? await semanticSearch(deps.db, deps.embedder, query, limit)
        : lexicalSearch(deps.db, query, limit);

    sendJson(ctx.res, 200, hits);
  };
