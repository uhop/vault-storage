import type {DatabaseSync} from 'node:sqlite';
import {RecordVecRepository} from '../../db/vec-repo.ts';
import {chunkBody} from '../../embeddings/chunker.ts';
import type {Embedder} from '../../embeddings/types.ts';
import type {EdgesRepository} from '../../records/edges.ts';
import type {RecordsRepository} from '../../records/repository.ts';
import type {VaultRecord} from '../../records/types.ts';
import {rejectUnknownParams} from '../query.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';
import {lexicalSearch, queryTerms} from './search.ts';

interface ContextPackDeps {
  db: DatabaseSync;
  records: RecordsRepository;
  edges: EdgesRepository;
  embedder: Embedder;
}

const DEFAULT_K = 8;
const MAX_K = 24;
// Same transport reality as the resume bundle's guard (decisions D20): the
// MCP result channel rejects large results, so a pack the server volunteers
// must be bounded by default. Explicit max_bytes overrides are honored.
const DEFAULT_MAX_BYTES = 32 * 1024;
const LEXICAL_POOL = 20;
// Reciprocal-rank fusion with the standard k=60 damping: robust to the two
// legs' incomparable score scales, no tuning surface.
const RRF_K = 60;
const GRAPH_CAP = 20;

interface Candidate {
  record: VaultRecord;
  /** Best semantic chunk, when the semantic leg saw this record. */
  chunkIndex: number | null;
  semanticScore?: number;
  lexicalScore?: number;
  fused: number;
}

const round4 = (n: number): number => Number(n.toFixed(4));

const summaryEntry = (r: VaultRecord) => ({
  record_id: r.recordId,
  file_path: r.filePath,
  title: r.title,
  summary: r.agentSummary
});

/** Segment with the most case-insensitive term occurrences; ties → first. */
const bestSegmentByTerms = (segments: string[], terms: string[]): number => {
  let bestIndex = 0;
  let bestCount = -1;
  for (let i = 0; i < segments.length; ++i) {
    const hay = segments[i]!.toLowerCase();
    let count = 0;
    for (const term of terms) {
      const needle = term.toLowerCase();
      for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
        ++count;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      bestIndex = i;
    }
  }
  return bestIndex;
};

/**
 * POST /context-pack?query=<text>|record_id=<id>&k=N&max_bytes=N
 *
 * One prepared context pack replacing the search → similar → neighborhood →
 * read chains agents assemble by hand (decisions D7: packaging over backend).
 * Exactly one of `query` / `record_id` anchors the pack:
 *
 * - `query` — hybrid retrieval: record-level RRF over the lexical FTS5 leg
 *   and the semantic chunk-KNN leg; each fused record contributes its best
 *   chunk. The graph context is rooted at the top fused record.
 * - `record_id` — the anchor's nearest records by chunk embeddings, each
 *   contributing its closest chunk; graph context rooted at the anchor.
 *
 * Chunk text is reproduced via `chunkBody(body, {summary: null})` — the bare
 * segmentation the stored vectors index (minus the HyDE summary prefix), so
 * `chunk_index` is meaningful against the embedding tables. The pack is
 * byte-budgeted: lowest-ranked chunks are dropped until the serialized
 * response fits `max_bytes`, and the drop count is reported — never silent.
 */
export const contextPackHandler =
  (deps: ContextPackDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, new Set(['query', 'record_id', 'k', 'max_bytes']))) return;

    const query = ctx.query['query'];
    const recordId = ctx.query['record_id'];
    if ((query === undefined) === (recordId === undefined)) {
      sendError(ctx.res, 400, 'bad_request', 'exactly one of query / record_id is required');
      return;
    }
    if (query !== undefined && query.length === 0) {
      sendError(ctx.res, 400, 'bad_request', 'query must not be empty');
      return;
    }

    const kRaw = ctx.query['k'];
    let k = kRaw === undefined ? DEFAULT_K : Number.parseInt(kRaw, 10);
    if (!Number.isFinite(k) || k < 1) {
      sendError(ctx.res, 400, 'bad_request', `k must be a positive integer (got ${kRaw})`);
      return;
    }
    if (k > MAX_K) k = MAX_K;

    const maxBytesRaw = ctx.query['max_bytes'];
    const maxBytes =
      maxBytesRaw === undefined ? DEFAULT_MAX_BYTES : Number.parseInt(maxBytesRaw, 10);
    if (!Number.isFinite(maxBytes) || maxBytes < 1) {
      sendError(
        ctx.res,
        400,
        'bad_request',
        `max_bytes must be a positive integer (got ${maxBytesRaw})`
      );
      return;
    }

    const {records, edges} = deps;
    const vecRepo = new RecordVecRepository(deps.db);

    let anchor: Record<string, unknown>;
    let graphRoot: VaultRecord | null;
    let ranked: Candidate[];
    let terms: string[] = [];

    if (recordId !== undefined) {
      const root = records.getById(recordId);
      if (!root) {
        sendError(ctx.res, 404, 'record_not_found', `no record with id ${recordId}`);
        return;
      }
      records.bumpLastReferenced(recordId);
      anchor = summaryEntry(root);
      graphRoot = root;
      ranked = vecRepo
        .nearestToRecord(recordId, k)
        .map((h): Candidate | null => {
          const record = records.getById(h.recordId);
          if (!record) return null;
          return {
            record,
            chunkIndex: h.chunkIndex,
            semanticScore: round4(1 - h.distance / 2),
            fused: 1 - h.distance / 2
          };
        })
        .filter((c): c is Candidate => c !== null);
    } else {
      terms = queryTerms(query!);
      const vec = await deps.embedder.embed(query!);
      const semantic = vecRepo.nearest(vec, Math.max(k, 10));
      const lexical = lexicalSearch(deps.db, query!, LEXICAL_POOL);

      const byId = new Map<string, Candidate>();
      semantic.forEach((h, rank) => {
        const record = records.getById(h.recordId);
        if (!record) return;
        byId.set(h.recordId, {
          record,
          chunkIndex: h.chunkIndex,
          semanticScore: round4(1 - h.distance / 2),
          fused: 1 / (RRF_K + rank + 1)
        });
      });
      lexical.forEach((h, rank) => {
        const record = records.getByPath(h.filename);
        if (!record) return;
        const weight = 1 / (RRF_K + rank + 1);
        const existing = byId.get(record.recordId);
        if (existing) {
          existing.lexicalScore = round4(h.score);
          existing.fused += weight;
        } else {
          byId.set(record.recordId, {
            record,
            chunkIndex: null,
            lexicalScore: round4(h.score),
            fused: weight
          });
        }
      });
      ranked = [...byId.values()].sort((a, b) => b.fused - a.fused);
      anchor = {query};
      graphRoot = ranked[0]?.record ?? null;
    }

    const chunks: Record<string, unknown>[] = [];
    for (const c of ranked) {
      if (chunks.length >= k) break;
      const segments = chunkBody(c.record.body, {summary: null});
      let index = c.chunkIndex ?? bestSegmentByTerms(segments, terms);
      // The stored chunk set can outrun the current body (edited since the
      // last embed pass) — clamp rather than 500 or silently skip.
      if (index >= segments.length) index = segments.length - 1;
      const text = segments[index] ?? '';
      if (text.length === 0) continue;
      const sources: string[] = [];
      if (c.semanticScore !== undefined) sources.push('semantic');
      if (c.lexicalScore !== undefined) sources.push('lexical');
      chunks.push({
        record_id: c.record.recordId,
        file_path: c.record.filePath,
        title: c.record.title,
        chunk_index: index,
        text,
        ...(c.semanticScore !== undefined ? {semantic_score: c.semanticScore} : {}),
        ...(c.lexicalScore !== undefined ? {lexical_score: c.lexicalScore} : {}),
        sources
      });
    }

    let graph: Record<string, unknown> | null = null;
    if (graphRoot) {
      const root = graphRoot;
      const outbound = edges.listOutbound(root.recordId);
      const inbound = edges.listInbound(root.recordId);

      const neighbors = new Map<
        string,
        {entry: ReturnType<typeof summaryEntry>; edges: {type: string; direction: string}[]}
      >();
      const addNeighbor = (otherId: string, type: string, direction: string): void => {
        if (otherId === root.recordId) return;
        let n = neighbors.get(otherId);
        if (!n) {
          const record = records.getById(otherId);
          if (!record) return;
          n = {entry: summaryEntry(record), edges: []};
          neighbors.set(otherId, n);
        }
        n.edges.push({type, direction});
      };
      for (const e of outbound) addNeighbor(e.toId, e.type, 'outbound');
      for (const e of inbound) addNeighbor(e.fromId, e.type, 'inbound');

      const neighborhood = [...neighbors.values()]
        .slice(0, GRAPH_CAP)
        .map(n => ({...n.entry, edges: n.edges}));

      const backlinks = inbound.slice(0, GRAPH_CAP).flatMap(e => {
        const record = records.getById(e.fromId);
        return record ? [{...summaryEntry(record), edge_type: e.type}] : [];
      });

      graph = {
        root: summaryEntry(root),
        neighborhood,
        neighborhood_total: neighbors.size,
        backlinks,
        backlinks_total: inbound.length
      };
    }

    const payload = {
      anchor,
      chunks,
      graph,
      budget: {max_bytes: maxBytes, used_bytes: 0, chunks_dropped: 0}
    };
    let dropped = 0;
    let used = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    while (used > maxBytes && chunks.length > 0) {
      chunks.pop();
      ++dropped;
      used = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    }
    payload.budget.used_bytes = used;
    payload.budget.chunks_dropped = dropped;

    sendJson(ctx.res, 200, payload);
  };
