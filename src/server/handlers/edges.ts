import type {DatabaseSync} from 'node:sqlite';
import type {EdgesRepository} from '../../records/edges.ts';
import {EDGE_TYPES, MIRRORED_EDGE_TYPES, type Edge, type EdgeType} from '../../records/types.ts';
import type {RecordsRepository} from '../../records/repository.ts';
import {
  parseFields,
  parsePagination,
  projectFields,
  rejectUnknownParams,
  splitCsv
} from '../query.ts';
import {asOf} from '../as-of.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';
import {toJsonEdge, toJsonRecord} from '../serialize.ts';
import {prepared} from '../../db/prepared.ts';

const EDGE_TYPE_SET: ReadonlySet<string> = new Set(EDGE_TYPES);
const MAX_DEPTH = 5;

// What `?fields=` and `?edge_fields=` on the neighborhood route are checked against:
// the JSON record without its body, and the JSON edge. The identity fields stay whatever
// was asked, so the client can still join layers to edges.
const RECORD_FIELDS: ReadonlySet<string> = new Set([
  'record_id',
  'file_path',
  'parent_path',
  'sequence_key',
  'type',
  'status',
  'priority',
  'title',
  'created',
  'updated',
  'modified_at',
  'last_referenced',
  'decay_score',
  'content_hash',
  'body_hash',
  'archived_at',
  'agent_summary',
  'agent_derived_from_hash'
]);
const RECORD_ALWAYS: ReadonlySet<string> = new Set(['record_id']);
const EDGE_FIELDS: ReadonlySet<string> = new Set([
  'from_id',
  'to_id',
  'type',
  'weight',
  'note',
  'created'
]);
const EDGE_ALWAYS: ReadonlySet<string> = new Set(['from_id', 'to_id', 'type']);

interface EdgesDeps {
  db: DatabaseSync;
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

/** Which stored rows the listing counts: a mirrored pair once. */
const LISTED = `(e.type NOT IN (${[...MIRRORED_EDGE_TYPES].map(t => `'${t}'`).join(', ')}) OR e.from_id < e.to_id)`;

interface ListedEdgeRow {
  type: EdgeType;
  weight: number;
  note: string | null;
  created: string;
  from_id: string;
  from_path: string;
  from_title: string | null;
  to_id: string;
  to_path: string;
  to_title: string | null;
}

/**
 * GET /edges?type=&offset=&limit=
 * Every stored edge, newest first, each with both records; `type` is a CSV
 * of edge types (unknown ones are a 400), `by_type` counts the whole table
 * under the same rule, a mirrored pair listed once. Behind the
 * edges page; agents get a note's own edges from the neighborhood route.
 */
export const listEdgesHandler =
  (deps: {db: DatabaseSync}): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, new Set(['type', 'offset', 'limit']))) return;
    const types = parseEdgeTypes(ctx.query['type']);
    if (typeof types === 'string') {
      sendError(ctx.res, 400, 'bad_request', types);
      return;
    }
    const {offset, limit} = parsePagination(ctx.query);
    const typeClause =
      types.length > 0 ? ` AND e.type IN (${types.map(() => '?').join(', ')})` : '';
    const rows = prepared(
      deps.db,
      `SELECT e.type, e.weight, e.note, e.created,
                e.from_id, f.file_path AS from_path, f.title AS from_title,
                e.to_id, t.file_path AS to_path, t.title AS to_title
           FROM edges e
           JOIN records f ON f.record_id = e.from_id
           JOIN records t ON t.record_id = e.to_id
          WHERE ${LISTED}${typeClause}
          ORDER BY e.created DESC, e.from_id, e.to_id, e.type
          LIMIT ? OFFSET ?`
    ).all(...types, limit, offset) as unknown[] as ListedEdgeRow[];
    const total = (
      prepared(deps.db, `SELECT COUNT(*) AS n FROM edges e WHERE ${LISTED}${typeClause}`).get(
        ...types
      ) as {n: number}
    ).n;
    const byType: Record<string, number> = Object.fromEntries(EDGE_TYPES.map(t => [t, 0]));
    for (const row of prepared(
      deps.db,
      `SELECT e.type, COUNT(*) AS n FROM edges e WHERE ${LISTED} GROUP BY e.type`
    ).all() as unknown[] as {type: string; n: number}[]) {
      byType[row.type] = row.n;
    }
    sendJson(ctx.res, 200, {
      items: rows.map(r => ({
        type: r.type,
        weight: r.weight,
        note: r.note,
        created: r.created,
        from: {record_id: r.from_id, file_path: r.from_path, title: r.from_title},
        to: {record_id: r.to_id, file_path: r.to_path, title: r.to_title}
      })),
      offset,
      limit,
      total,
      by_type: byType,
      as_of: asOf(deps.db)
    });
  };

const parseDirection = (raw: string | undefined): 'outbound' | 'inbound' | 'both' | string => {
  if (raw === undefined || raw === '') return 'both';
  if (raw === 'outbound' || raw === 'inbound' || raw === 'both') return raw;
  return `unknown direction: ${raw}`;
};

const filterByType = (edges: Edge[], types: EdgeType[]): Edge[] =>
  types.length === 0 ? edges : edges.filter(e => types.includes(e.type));

/**
 * GET /sections/{id}/neighborhood?depth=N&via=type1,type2&direction=outbound|inbound|both&fields=&edge_fields=
 *
 * BFS from `id`. Each level is the set of record_ids one edge-step away from
 * the previous level (via filtered edge types in the requested direction),
 * minus anything already visited. Returns the root record, the layered
 * structure, and every traversed edge so the client can rebuild the subgraph;
 * `fields` and `edge_fields` keep only the named record and edge fields, the
 * ids always, since a depth-2 answer on a real vault is megabytes otherwise.
 */
export const neighborhoodHandler =
  (deps: EdgesDeps): Handler =>
  ctx => {
    // Precedes bumpLastReferenced: a rejected request must not leave a trace.
    if (!rejectUnknownParams(ctx, new Set(['depth', 'via', 'direction', 'fields', 'edge_fields'])))
      return;
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
    const fields = parseFields(ctx, RECORD_FIELDS);
    if (fields === null) return;
    const edgeFields = parseFields(ctx, EDGE_FIELDS, 'edge_fields');
    if (edgeFields === null) return;

    const direction = parseDirection(ctx.query['direction']);
    if (
      typeof direction === 'string' &&
      direction !== 'outbound' &&
      direction !== 'inbound' &&
      direction !== 'both'
    ) {
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
    const recordsById = new Map<string, Record<string, unknown>>();
    for (const rid of allRecordIds) {
      const r = records.getById(rid);
      if (r)
        recordsById.set(
          rid,
          projectFields(toJsonRecord(r, {includeBody: false}), fields, RECORD_ALWAYS)
        );
    }

    sendJson(ctx.res, 200, {
      root_id: id,
      root: projectFields(toJsonRecord(root, {includeBody: false}), fields, RECORD_ALWAYS),
      depth,
      direction,
      via: types,
      layers: layers.map(l => ({
        depth: l.depth,
        records: l.record_ids
          .map(rid => recordsById.get(rid))
          .filter((r): r is Record<string, unknown> => r !== undefined)
      })),
      edges: dedupeEdges(collectedEdges).map(e =>
        projectFields(toJsonEdge(e), edgeFields, EDGE_ALWAYS)
      )
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
    if (!rejectUnknownParams(ctx, new Set(['type', 'offset', 'limit']))) return;
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

    sendJson(ctx.res, 200, {items, offset, limit, total, as_of: asOf(deps.db)});
  };
