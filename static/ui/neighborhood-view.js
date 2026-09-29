// A multi-hop neighborhood, arranged for the neighborhood page: the route's
// layers and edges in, one entry per note per hop with the edges that reached
// it from the hop before, out. Pure: no DOM.

import {SYMMETRIC_TYPES, titleOf, TYPE_ORDER} from './note-links.js';

/** A hop past this many notes folds its tail. */
export const SHOW_FIRST = 40;

const rank = type => {
  const i = TYPE_ORDER.indexOf(type);
  return i === -1 ? TYPE_ORDER.length : i;
};

/**
 * [{depth, notes: [{record, via: [{type, direction, other}]}]}], a note's `via`
 * being the edges that connect it to a note of the hop before (the root for
 * hop 1, `other: null`): `direction` is `out` when this note points at the
 * earlier one, `in` when the earlier one points at it, `both` for a mirrored
 * type, read as the Links block reads them.
 * Notes sort by their strongest type in TYPE_ORDER, then by title.
 */
export const arrangeHops = (rootId, neighborhood) => {
  const byId = new Map();
  const depthOf = new Map([[rootId, 0]]);
  for (const layer of neighborhood.layers ?? []) {
    for (const r of layer.records ?? []) {
      byId.set(r.record_id, r);
      if (!depthOf.has(r.record_id)) depthOf.set(r.record_id, layer.depth);
    }
  }
  const via = new Map();
  const add = (id, entry) => {
    let list = via.get(id);
    if (!list) via.set(id, (list = []));
    if (!list.some(v => v.type === entry.type && v.other === entry.other)) list.push(entry);
  };
  for (const e of neighborhood.edges ?? []) {
    const df = depthOf.get(e.from_id);
    const dt = depthOf.get(e.to_id);
    if (df === undefined || dt === undefined) continue;
    if (dt === df + 1) add(e.to_id, {type: e.type, direction: 'in', other: e.from_id});
    else if (df === dt + 1) add(e.from_id, {type: e.type, direction: 'out', other: e.to_id});
  }
  const best = list => (list.length ? Math.min(...list.map(v => rank(v.type))) : TYPE_ORDER.length);
  const hops = [];
  for (const layer of neighborhood.layers ?? []) {
    const notes = (layer.records ?? [])
      .filter(r => depthOf.get(r.record_id) === layer.depth)
      .map(r => {
        const list = (via.get(r.record_id) ?? []).map(v => ({
          type: v.type,
          direction: SYMMETRIC_TYPES.has(v.type) ? 'both' : v.direction,
          other: v.other === rootId ? null : (byId.get(v.other) ?? null)
        }));
        list.sort((a, b) => rank(a.type) - rank(b.type));
        return {record: r, via: list};
      })
      .sort(
        (a, b) => best(a.via) - best(b.via) || titleOf(a.record).localeCompare(titleOf(b.record))
      );
    hops.push({depth: layer.depth, notes});
  }
  return hops;
};

/** A hop's [type, count] pairs in TYPE_ORDER, for its heading. */
export const countTypes = hop => {
  const counts = new Map();
  for (const n of hop.notes)
    for (const v of n.via) counts.set(v.type, (counts.get(v.type) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => rank(a[0]) - rank(b[0]));
};

const arrow = direction => (direction === 'both' ? '↔' : direction === 'out' ? '→' : '←');

const noteLink = (r, esc) =>
  `<a href="/ui/note.html?path=${encodeURIComponent(r.file_path)}"><b>${esc(titleOf(r))}</b><small>${esc(r.file_path)}</small></a>`;

const viaText = (v, esc, rootTitle) =>
  `<span class="via"><span class="type">${esc(v.type)}</span> ${arrow(v.direction)} ${esc(v.other ? titleOf(v.other) : rootTitle)}</span>`;

/** One section per non-empty hop: a heading with the note and type counts, the notes, a folded tail past SHOW_FIRST. */
export const renderHops = (hops, esc, rootTitle) =>
  hops
    .filter(hop => hop.notes.length > 0)
    .map(hop => {
      const counts = countTypes(hop)
        .map(([t, n]) => `${esc(t)} ${n}`)
        .join(' · ');
      const items = hop.notes.map(
        n =>
          `<li>${noteLink(n.record, esc)}<span class="vias">${n.via.map(v => viaText(v, esc, rootTitle)).join('')}</span></li>`
      );
      const rest = items.length - SHOW_FIRST;
      const tail =
        rest > 0
          ? `<details class="more"><summary>${rest} more</summary><ul>${items.slice(SHOW_FIRST).join('')}</ul></details>`
          : '';
      const n = hop.notes.length;
      return `<section class="hop"><h2>Hop ${hop.depth} · ${n} note${n === 1 ? '' : 's'}${counts ? ` · ${counts}` : ''}</h2><ul>${items.slice(0, SHOW_FIRST).join('')}</ul>${tail}</section>`;
    })
    .join('');
