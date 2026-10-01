// The search page's edge facet (D130): the rows the facet route counts, each
// cycling off, has, lacks, written as the search route's `edge=` conditions.
// Pure: no DOM.

import {TYPE_ORDER} from './note-links.js';

export const ARROW = {out: '→', in: '←', both: '↔'};
const PARAM = {out: 'outbound', in: 'inbound', both: 'both'};
const FROM_PARAM = {outbound: 'out', inbound: 'in', both: 'both'};
const DIRECTION_ORDER = {out: 0, both: 1, in: 2};
const NEXT = {off: 'has', has: 'lacks', lacks: 'off'};

const rank = type => {
  const i = TYPE_ORDER.indexOf(type);
  return i === -1 ? TYPE_ORDER.length : i;
};

/** A row's key: its type and direction. */
export const keyOf = (type, direction) => `${type} ${direction}`;

/**
 * `edge=` as {picks: Map(key → 'has' | 'lacks'), extra: [conditions]}: the
 * conditions the facet writes, `[!]<type>:<direction>`, and the others kept
 * as written, so a URL made elsewhere survives the page.
 */
export const parseEdgeParam = raw => {
  const picks = new Map();
  const extra = [];
  for (const part of (raw ?? '')
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)) {
    const m = /^(!?)([a-z-]+):(outbound|inbound|both)$/.exec(part);
    if (m && TYPE_ORDER.includes(m[2]))
      picks.set(keyOf(m[2], FROM_PARAM[m[3]]), m[1] ? 'lacks' : 'has');
    else extra.push(part);
  }
  return {picks, extra};
};

/** The picks and the kept conditions as the search route's `edge=`; empty for none. */
export const edgeParam = (picks, extra = []) =>
  [
    ...[...picks].map(([key, state]) => {
      const [type, direction] = key.split(' ');
      return `${state === 'lacks' ? '!' : ''}${type}:${PARAM[direction]}`;
    }),
    ...extra
  ].join(',');

/** The state after a click: off, has, lacks, off. */
export const cycle = state => NEXT[state ?? 'off'];

/** The facet route's rows, and any picked row it no longer counts at 0, in type and direction order. */
export const facetRows = (edges, picks) => {
  const rows = new Map((edges ?? []).map(e => [keyOf(e.type, e.direction), {...e}]));
  for (const key of picks.keys()) {
    if (rows.has(key)) continue;
    const [type, direction] = key.split(' ');
    rows.set(key, {type, direction, hits: 0});
  }
  return [...rows.values()].sort(
    (a, b) =>
      rank(a.type) - rank(b.type) || DIRECTION_ORDER[a.direction] - DIRECTION_ORDER[b.direction]
  );
};

const STATE_LABEL = {off: '', has: 'has', lacks: 'has none'};

/** The facet: a total, a button per row with its arrow, count, and state, and a Clear when anything is picked. */
export const renderFacets = (rows, picks, extra, total, esc) => {
  const buttons = rows
    .map(r => {
      const key = keyOf(r.type, r.direction);
      const state = picks.get(key) ?? 'off';
      const label = `${r.type} ${ARROW[r.direction]} ${r.hits}${STATE_LABEL[state] ? `, ${STATE_LABEL[state]}` : ''}`;
      return `<button type="button" class="facet" data-key="${esc(key)}" data-state="${state}"${r.hits === 0 && state === 'off' ? ' disabled' : ''} aria-label="${esc(label)}"><span class="type">${esc(r.type)}</span> <span class="arrow">${ARROW[r.direction]}</span> <span class="count">${r.hits}</span></button>`;
    })
    .join('');
  const others = extra.length ? `<span class="others">also ${esc(extra.join(', '))}</span>` : '';
  const clear =
    picks.size || extra.length ? '<button type="button" class="facet-clear">Clear</button>' : '';
  return `<span class="total">${total} match${total === 1 ? '' : 'es'}</span>${buttons}${others}${clear}`;
};

/** A hit's edges as [{type, direction, count}], in type and direction order. */
export const summarizeEdges = edges => {
  const counts = new Map();
  for (const e of edges ?? []) {
    const key = keyOf(e.type, e.direction);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts]
    .map(([key, count]) => {
      const [type, direction] = key.split(' ');
      return {type, direction, count};
    })
    .sort(
      (a, b) =>
        rank(a.type) - rank(b.type) || DIRECTION_ORDER[a.direction] - DIRECTION_ORDER[b.direction]
    );
};

/** Whether a hit's edge of `direction` meets a pick of `picked` direction for its type. */
const meets = (picked, direction) =>
  picked === direction || picked === 'both' || direction === 'both';

/** A hit's edge summary, the groups a `has` pick matched marked. */
export const renderEdgeSummary = (summary, picks, esc) =>
  summary
    .map(s => {
      const matched = [...picks].some(([key, state]) => {
        const [type, direction] = key.split(' ');
        return state === 'has' && type === s.type && meets(direction, s.direction);
      });
      return `<span class="edge${matched ? ' match' : ''}"><span class="type">${esc(s.type)}</span> ${ARROW[s.direction]} ${s.count}</span>`;
    })
    .join('');
