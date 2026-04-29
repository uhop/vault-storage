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
  const pattern = `%${escapeLike(query)}%`;
  const rows = db
    .prepare(
      `SELECT file_path, body, title FROM records
        WHERE body LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
        ORDER BY updated DESC`
    )
    .all(pattern, pattern) as unknown[] as {
    file_path: string;
    body: string;
    title: string | null;
  }[];

  const hits: SearchHit[] = [];
  for (const row of rows) {
    const matches = findMatches(row.body, query);
    const titleHits = row.title ? findMatches(row.title, query).length : 0;
    if (matches.length === 0 && titleHits === 0) continue;
    hits.push({
      filename: row.file_path,
      score: matches.length + titleHits * 3,
      matches
    });
    if (hits.length >= limit) break;
  }
  hits.sort((a, b) => b.score - a.score);
  return hits;
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
    const limit = Math.min(
      100,
      Math.max(1, limitRaw ? Number.parseInt(limitRaw, 10) || 20 : 20)
    );

    const hits =
      mode === 'semantic'
        ? await semanticSearch(deps.db, deps.embedder, query, limit)
        : lexicalSearch(deps.db, query, limit);

    sendJson(ctx.res, 200, hits);
  };
