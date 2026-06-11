import type {EdgesRepository} from '../../records/edges.ts';
import {EDGE_TYPES, type Edge, type EdgeType} from '../../records/types.ts';
import type {RecordsRepository} from '../../records/repository.ts';
import {parsePagination, splitCsv} from '../query.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';
import {toJsonRecord} from '../serialize.ts';

const EDGE_TYPE_SET: ReadonlySet<string> = new Set(EDGE_TYPES);
const MAX_DEPTH = 5;

interface EdgesDeps {
  records: RecordsRepository;
  edges: EdgesRepository;
}

const parseEdgeTypes = (raw: string | undefined): EdgeType[] | string => {
  const types = splitCsv(raw);
  for (const t of types) {
    if (!EDGE_TYPE_SET.has(t)) return `unknown edge type: ${t}`;
  }
  return types as EdgeType[];
};

const parseDirection = (raw: string | undefined): 'outbound' | 'inbound' | 'both' | string => {
  if (raw === undefined || raw === '') return 'both';
  if (raw === 'outbound' || raw === 'inbound' || raw === 'both') return raw;
  return `unknown direction: ${raw}`;
};

const filterByType = (edges: Edge[], types: EdgeType[]): Edge[] =>
  types.length === 0 ? edges : edges.filter(e => types.includes(e.type));

/**
 * GET /sections/{id}/neighborhood?depth=N&via=type1,type2&direction=outbound|inbound|both
 *
 * BFS from `id`. Each level is the set of record_ids one edge-step away from
 * the previous level (via filtered edge types in the requested direction),
 * minus anything already visited. Returns the layered structure plus every
 * traversed edge so the client can rebuild the subgraph.
 */
export const neighborhoodHandler =
  (deps: EdgesDeps): Handler =>
  ctx => {
    const id = ctx.params['id'];
    if (!id) {
      sendError(ctx.res, 400, 'bad_request', 'missing record_id');
      return;
    }

    const {records} = deps;
    const root = records.getById(id);
    if (!root) {
      sendError(ctx.res, 404, 'record_not_found', `no record with id ${id}`);
      return;
    }
    // Phase E: bump last_referenced on the root only. Reachable neighbours
    // discovered by traversal are not bumped — single agent query
    // shouldn't reinforce a transitive cluster.
    records.bumpLastReferenced(id);

    const types = parseEdgeTypes(ctx.query['via']);
    if (typeof types === 'string') {
      sendError(ctx.res, 400, 'bad_request', types);
      return;
    }

    const direction = parseDirection(ctx.query['direction']);
    if (typeof direction === 'string' && direction !== 'outbound' && direction !== 'inbound' && direction !== 'both') {
      sendError(ctx.res, 400, 'bad_request', direction);
      return;
    }

    const depthRaw = ctx.query['depth'];
    let depth = depthRaw === undefined ? 1 : Number.parseInt(depthRaw, 10);
    if (!Number.isFinite(depth) || depth < 1) {
      sendError(ctx.res, 400, 'bad_request', `depth must be a positive integer (got ${depthRaw})`);
      return;
    }
    if (depth > MAX_DEPTH) depth = MAX_DEPTH;

    const edgeRepo = deps.edges;

    const visited = new Set<string>([id]);
    const layers: Array<{depth: number; record_ids: string[]}> = [];
    const collectedEdges: Edge[] = [];
    let frontier = [id];

    for (let d = 1; d <= depth && frontier.length > 0; d++) {
      const next = new Set<string>();
      for (const fromId of frontier) {
        const outbound = direction === 'inbound' ? [] : edgeRepo.listOutbound(fromId);
        const inbound = direction === 'outbound' ? [] : edgeRepo.listInbound(fromId);
        for (const e of filterByType(outbound, types)) {
          collectedEdges.push(e);
          if (!visited.has(e.toId)) next.add(e.toId);
        }
        for (const e of filterByType(inbound, types)) {
          collectedEdges.push(e);
          if (!visited.has(e.fromId)) next.add(e.fromId);
        }
      }
      const layerIds = [...next];
      layerIds.forEach(rid => visited.add(rid));
      layers.push({depth: d, record_ids: layerIds});
      frontier = layerIds;
    }

    const allRecordIds = [id, ...layers.flatMap(l => l.record_ids)];
    const recordsById = new Map<string, ReturnType<typeof toJsonRecord>>();
    for (const rid of allRecordIds) {
      const r = records.getById(rid);
      if (r) recordsById.set(rid, toJsonRecord(r, {includeBody: false}));
    }

    sendJson(ctx.res, 200, {
      root_id: id,
      depth,
      direction,
      via: types,
      layers: layers.map(l => ({
        depth: l.depth,
        records: l.record_ids
          .map(rid => recordsById.get(rid))
          .filter((r): r is ReturnType<typeof toJsonRecord> => r !== undefined)
      })),
      edges: dedupeEdges(collectedEdges).map(e => ({
        from_id: e.fromId,
        to_id: e.toId,
        type: e.type,
        weight: e.weight,
        note: e.note,
        created: e.created
      }))
    });
  };

const dedupeEdges = (edges: Edge[]): Edge[] => {
  const seen = new Set<string>();
  const out: Edge[] = [];
  for (const e of edges) {
    const k = `${e.fromId}|${e.toId}|${e.type}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
};

/**
 * GET /sections/{id}/backlinks?type=type1,type2&offset=&limit=
 * Common-case shortcut for "what cites/relates to this record".
 */
export const backlinksHandler =
  (deps: EdgesDeps): Handler =>
  ctx => {
    const id = ctx.params['id'];
    if (!id) {
      sendError(ctx.res, 400, 'bad_request', 'missing record_id');
      return;
    }

    const {records} = deps;
    const root = records.getById(id);
    if (!root) {
      sendError(ctx.res, 404, 'record_not_found', `no record with id ${id}`);
      return;
    }
    records.bumpLastReferenced(id);

    const types = parseEdgeTypes(ctx.query['type']);
    if (typeof types === 'string') {
      sendError(ctx.res, 400, 'bad_request', types);
      return;
    }

    const {offset, limit} = parsePagination(ctx.query);
    const all = filterByType(deps.edges.listInbound(id), types);
    const total = all.length;
    const page = all.slice(offset, offset + limit);

    const items = page.map(e => {
      const from = records.getById(e.fromId);
      return {
        edge: {
          from_id: e.fromId,
          to_id: e.toId,
          type: e.type,
          weight: e.weight,
          note: e.note,
          created: e.created
        },
        from_record: from ? toJsonRecord(from, {includeBody: false}) : null
      };
    });

    sendJson(ctx.res, 200, {items, offset, limit, total});
  };
