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

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

const lexicalSearch = (db: DatabaseSync, query: string, limit: number): SearchHit[] => {
  // Tokenize on whitespace: every term must be present (AND), each matched
  // independently anywhere in body or title. The previous single-substring
  // LIKE required all words to be adjacent, so a multi-word query whose terms
  // were scattered across the note returned nothing.
  const terms = query.split(/\s+/).filter(t => t.length > 0);
  if (terms.length === 0) return [];

  // One `(LOWER(body) LIKE ? OR LOWER(title) LIKE ?)` clause per term, AND-ed.
  // LOWER on both sides makes the prefilter case-insensitive regardless of
  // SQLite's LIKE collation, matching the case-folding `findMatches` does
  // below — so a lowercase query can't miss a Titlecase-only occurrence.
  const clause = terms
    .map(() => `(LOWER(body) LIKE ? ESCAPE '\\' OR LOWER(title) LIKE ? ESCAPE '\\')`)
    .join(' AND ');
  const params: string[] = [];
  for (const term of terms) {
    const pattern = `%${escapeLike(term.toLowerCase())}%`;
    params.push(pattern, pattern);
  }

  const rows = db
    .prepare(`SELECT file_path, body, title FROM records WHERE ${clause} ORDER BY updated DESC`)
    .all(...params) as unknown[] as {
    file_path: string;
    body: string;
    title: string | null;
  }[];

  // Score EVERY matching row, then sort by score and take the top `limit`.
  // The old code sliced to `limit` in `updated DESC` order *before* scoring,
  // so for a high-frequency term the strongest (title) match could be dropped
  // when it wasn't among the most recently updated rows.
  const hits: SearchHit[] = [];
  for (const row of rows) {
    let score = 0;
    const matches: MatchSpan[] = [];
    for (const term of terms) {
      const bodyMatches = findMatches(row.body, term);
      const titleHits = row.title ? findMatches(row.title, term).length : 0;
      score += bodyMatches.length + titleHits * 3;
      for (const m of bodyMatches) {
        if (matches.length < MAX_MATCHES_PER_FILE) matches.push(m);
      }
    }
    if (score === 0) continue; // defensive: SQL AND guarantees each term hit
    hits.push({filename: row.file_path, score, matches});
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
