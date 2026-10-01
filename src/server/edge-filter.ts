// The edge conditions a search can carry (D129), and each hit's edges.

import type {DatabaseSync, SQLInputValue} from 'node:sqlite';
import {prepared} from '../db/prepared.ts';
import {EDGE_TYPES} from '../records/types.ts';

export type EdgeDirection = 'outbound' | 'inbound' | 'both';

export interface EdgeCondition {
  negate: boolean;
  types: string[];
  direction: EdgeDirection;
  /** The record at the other end, when the condition names one. */
  other: string | null;
}

const DIRECTIONS: ReadonlySet<string> = new Set(['outbound', 'inbound', 'both']);
const TYPES: ReadonlySet<string> = new Set(EDGE_TYPES);

/** The syntax, for an error message and a tool description. */
export const EDGE_FILTER_SYNTAX =
  '[!]<type>[|<type>…][:outbound|inbound|both[:<record_id>]], several separated by commas';

/**
 * `edge=` as conditions joined by AND: commas separate them (the router joins
 * a repeated parameter with commas too), `|` the types a condition accepts, `!`
 * negates. Throws a SyntaxError naming the condition it cannot read.
 */
export const parseEdgeFilter = (raw: string): EdgeCondition[] =>
  raw.split(',').map(part => {
    const text = part.trim();
    const negate = text.startsWith('!');
    const [typeList = '', direction = 'both', other = '', ...rest] = (
      negate ? text.slice(1) : text
    ).split(':');
    const types = typeList.split('|').filter(Boolean);
    const unknown = types.find(t => !TYPES.has(t));
    if (!types.length || unknown !== undefined || !DIRECTIONS.has(direction) || rest.length) {
      throw new SyntaxError(
        `edge condition "${text}" is not ${EDGE_FILTER_SYNTAX}; types: ${EDGE_TYPES.join(', ')}`
      );
    }
    return {negate, types, direction: direction as EdgeDirection, other: other || null};
  });

const exists = (
  near: 'from_id' | 'to_id',
  far: 'from_id' | 'to_id',
  column: string,
  c: EdgeCondition
): {sql: string; params: SQLInputValue[]} => ({
  sql: `EXISTS (SELECT 1 FROM edges e WHERE e.${near} = ${column} AND e.type IN (${c.types.map(() => '?').join(', ')})${c.other ? ` AND e.${far} = ?` : ''})`,
  params: c.other ? [...c.types, c.other] : [...c.types]
});

/** A WHERE fragment testing the record id in `column` against every condition, with its bindings. */
export const edgeFilterSql = (
  conditions: readonly EdgeCondition[],
  column: string
): {sql: string; params: SQLInputValue[]} => {
  const parts: string[] = [];
  const params: SQLInputValue[] = [];
  for (const c of conditions) {
    const out = exists('from_id', 'to_id', column, c);
    const into = exists('to_id', 'from_id', column, c);
    const test =
      c.direction === 'outbound'
        ? out
        : c.direction === 'inbound'
          ? into
          : {sql: `(${out.sql} OR ${into.sql})`, params: [...out.params, ...into.params]};
    parts.push(c.negate ? `NOT ${test.sql}` : test.sql);
    params.push(...test.params);
  }
  return {sql: parts.join(' AND '), params};
};

export interface HitEdge {
  type: string;
  /** `out` when the hit points at the other note, `in` when it is pointed at, `both` for a pair. */
  direction: 'out' | 'in' | 'both';
  other: {record_id: string; file_path: string; title: string | null};
}

const ORDER = new Map<string, number>(EDGE_TYPES.map((t, i) => [t, i]));
const DIRECTION_ORDER = {out: 0, both: 1, in: 2} as const;

/**
 * Each record's edges, by record id: a type running both ways with one note
 * once as `both`, sorted by type, direction, and the other note's path.
 */
export const edgesOf = (db: DatabaseSync, ids: readonly string[]): Map<string, HitEdge[]> => {
  const out = new Map<string, HitEdge[]>(ids.map(id => [id, []]));
  if (!ids.length) return out;
  const json = JSON.stringify(ids);
  const rows = prepared(
    db,
    `SELECT e.from_id AS hit, e.type, 'out' AS direction, o.record_id, o.file_path, o.title
       FROM edges e JOIN records o ON o.record_id = e.to_id
      WHERE e.from_id IN (SELECT value FROM json_each(?))
     UNION ALL
     SELECT e.to_id AS hit, e.type, 'in' AS direction, o.record_id, o.file_path, o.title
       FROM edges e JOIN records o ON o.record_id = e.from_id
      WHERE e.to_id IN (SELECT value FROM json_each(?))`
  ).all(json, json) as unknown[] as Array<{
    hit: string;
    type: string;
    direction: 'out' | 'in';
    record_id: string;
    file_path: string;
    title: string | null;
  }>;
  const seen = new Map<string, HitEdge>();
  for (const r of rows) {
    const key = `${r.hit}\t${r.type}\t${r.record_id}`;
    const known = seen.get(key);
    if (known) {
      if (known.direction !== r.direction) known.direction = 'both';
      continue;
    }
    const edge: HitEdge = {
      type: r.type,
      direction: r.direction,
      other: {record_id: r.record_id, file_path: r.file_path, title: r.title}
    };
    seen.set(key, edge);
    out.get(r.hit)?.push(edge);
  }
  for (const list of out.values()) {
    list.sort(
      (a, b) =>
        (ORDER.get(a.type) ?? ORDER.size) - (ORDER.get(b.type) ?? ORDER.size) ||
        DIRECTION_ORDER[a.direction] - DIRECTION_ORDER[b.direction] ||
        a.other.file_path.localeCompare(b.other.file_path)
    );
  }
  return out;
};
