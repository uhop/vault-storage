// The neighborhood as a drawing: a radial layout of the notes the list shows,
// the root at the center and hop d on ring d, each note in the sector of the
// note that reached it (D126). Pure: no DOM.

import {SYMMETRIC_TYPES, titleOf, TYPE_ORDER} from './note-links.js';

/** Notes drawn at most by default, besides the root: Neo4j Browser's `maxNewNeighbours` (D128). */
export const DRAW_FIRST = 100;
/** The least distance between rings, in viewBox units. */
export const RING = 190;
/** The least arc between neighbors on a ring, in viewBox units. */
export const MIN_ARC = 26;
const MARGIN = 175;
const NODE_R = 6;
const ROOT_R = 10;
const TAU = 2 * Math.PI;

/** Each type's stroke, and a dash for the two that share a color with another. */
export const TYPE_STYLE = {
  supersedes: {color: 'var(--warn)'},
  revises: {color: 'var(--warn)', dash: '5 3'},
  contradicts: {color: 'var(--bad)'},
  'derived-from': {color: 'var(--accent)'},
  'applies-to': {color: 'var(--ok)'},
  cites: {color: 'var(--muted)'},
  'related-to': {color: 'var(--muted)', dash: '2 3'}
};
const styleOf = type => TYPE_STYLE[type] ?? {color: 'var(--muted)'};

const weigh = node => (node.weight = 1 + node.children.reduce((sum, c) => sum + weigh(c), 0));

const place = (node, start, span) => {
  node.angle = start + span / 2;
  const total = node.weight - 1;
  let from = start;
  for (const child of node.children) {
    const share = (span * child.weight) / total;
    place(child, from, share);
    from += share;
  }
};

/** Spread a ring's notes to at least MIN_ARC apart, moving them as a group as little as it can. */
const spread = (ring, radius) => {
  ring.sort((a, b) => a.angle - b.angle);
  const n = ring.length;
  const gap = Math.min(MIN_ARC / radius, TAU / n);
  const angles = ring.map(node => node.angle);
  for (let i = 1; i < n; ++i) angles[i] = Math.max(angles[i], angles[i - 1] + gap);
  if (angles[n - 1] - angles[0] > TAU - gap) {
    for (let i = 1; i < n; ++i) angles[i] = angles[0] + (i * TAU) / n;
  }
  const shift = angles.reduce((sum, a, i) => sum + a - ring[i].angle, 0) / n;
  ring.forEach((node, i) => (node.angle = angles[i] - shift));
};

/**
 * {nodes: [{id, record, depth, parent, angle, x, y}], edges: [{from, to, type,
 * directed}], left, rings: [{depth, radius}], radius}: the notes taken hop by
 * hop in the list's order up to `cap`, each under the first note of its `via`
 * that is drawn (the root for hop 1), placed in that note's sector on ring
 * `depth`, a ring wide enough for its notes at MIN_ARC apart and at least RING
 * outside the one before; the edges among them, a mirrored pair once; `left`
 * counts the notes the cap left out.
 */
export const layoutGraph = (rootId, root, hops, edges, cap = DRAW_FIRST) => {
  const top = {id: rootId, record: root, depth: 0, parent: null, children: []};
  const nodes = new Map([[rootId, top]]);
  let left = 0;
  for (const hop of hops) {
    for (const note of hop.notes) {
      const parent = note.via
        .map(v => (v.other ? v.other.record_id : rootId))
        .find(id => nodes.has(id));
      if (nodes.size > cap || parent === undefined) {
        ++left;
        continue;
      }
      const node = {
        id: note.record.record_id,
        record: note.record,
        depth: hop.depth,
        parent,
        children: []
      };
      nodes.set(node.id, node);
      nodes.get(parent).children.push(node);
    }
  }
  weigh(top);
  place(top, 0, TAU);
  top.angle = 0;
  const rings = new Map();
  for (const node of nodes.values()) {
    if (node.depth === 0) continue;
    let ring = rings.get(node.depth);
    if (!ring) rings.set(node.depth, (ring = []));
    ring.push(node);
  }
  const radii = new Map([[0, 0]]);
  for (const depth of [...rings.keys()].sort((a, b) => a - b)) {
    const inner = radii.get(depth - 1) ?? 0;
    const radius = Math.max(inner + RING, (rings.get(depth).length * MIN_ARC) / TAU);
    radii.set(depth, radius);
    spread(rings.get(depth), radius);
  }
  for (const node of nodes.values()) {
    const r = radii.get(node.depth);
    node.x = r * Math.sin(node.angle);
    node.y = -r * Math.cos(node.angle);
  }
  const drawn = new Map();
  for (const e of edges) {
    if (e.from_id === e.to_id || !nodes.has(e.from_id) || !nodes.has(e.to_id)) continue;
    const directed = !SYMMETRIC_TYPES.has(e.type);
    const [from, to] =
      directed || e.from_id < e.to_id ? [e.from_id, e.to_id] : [e.to_id, e.from_id];
    const key = `${from}\t${to}\t${e.type}`;
    if (!drawn.has(key)) drawn.set(key, {from, to, type: e.type, directed});
  }
  const order = type => {
    const i = TYPE_ORDER.indexOf(type);
    return i === -1 ? TYPE_ORDER.length : i;
  };
  return {
    nodes: [...nodes.values()].map(({children, weight, ...node}) => node),
    edges: [...drawn.values()].sort((a, b) => order(b.type) - order(a.type)),
    left,
    rings: [...radii].filter(([depth]) => depth > 0).map(([depth, radius]) => ({depth, radius})),
    radius: Math.max(RING, ...radii.values())
  };
};

const short = (s, n = 22) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const num = v => Number(v.toFixed(1));

/** Along the ray from the center, outward; turned over on the left so it never reads upside down. */
const label = (node, esc) => {
  const title = esc(short(titleOf(node.record)));
  if (node.depth === 0)
    return `<text x="0" y="${ROOT_R + 16}" text-anchor="middle">${title}</text>`;
  const sin = Math.sin(node.angle);
  const cos = -Math.cos(node.angle);
  const x = num(node.x + 10 * sin);
  const y = num(node.y + 10 * cos);
  const left = sin < 0;
  const turn = num((node.angle * 180) / Math.PI - 90 + (left ? 180 : 0));
  return `<text x="${x}" y="${y}" dy="0.35em" text-anchor="${left ? 'end' : 'start'}" transform="rotate(${turn} ${x} ${y})">${title}</text>`;
};

const line = (edge, at, esc) => {
  const a = at.get(edge.from);
  const b = at.get(edge.to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const cut = (b.depth === 0 ? ROOT_R : NODE_R) + (edge.directed ? 2 : 0);
  const {color, dash} = styleOf(edge.type);
  const style = `stroke:${color}${dash ? `;stroke-dasharray:${dash}` : ''}`;
  const marker =
    edge.directed && TYPE_ORDER.includes(edge.type) ? ` marker-end="url(#arrow-${edge.type})"` : '';
  return `<line class="edge" data-type="${esc(edge.type)}" x1="${num(a.x)}" y1="${num(a.y)}" x2="${num(b.x - (dx * cut) / len)}" y2="${num(b.y - (dy * cut) / len)}" style="${style}"${marker}/>`;
};

/**
 * The layout as an SVG string: guide rings, the edges colored by type with an
 * arrowhead on the directed ones, and each note as a link to `href(record)`,
 * its title cut short beside it and whole in its `<title>`.
 */
/** The view that shows the whole drawing: {x, y, w, h} in drawing units. */
export const fitView = layout => {
  const r = layout.radius + MARGIN;
  return {x: -r, y: -r, w: 2 * r, h: 2 * r};
};

/** How far a view may zoom in, as a multiple of the fit. */
export const ZOOM_MAX = 8;

const clampView = (view, fit) => ({
  ...view,
  x: Math.min(fit.x + fit.w - view.w, Math.max(fit.x, view.x)),
  y: Math.min(fit.y + fit.h - view.h, Math.max(fit.y, view.y))
});

/** `view` zoomed by `factor` about `at`, which stays put; kept between the fit and ZOOM_MAX, inside the fit. */
export const zoomView = (view, fit, factor, at) => {
  const w = Math.min(fit.w, Math.max(fit.w / ZOOM_MAX, view.w / factor));
  const k = w / view.w;
  return clampView(
    {x: at.x - (at.x - view.x) * k, y: at.y - (at.y - view.y) * k, w, h: view.h * k},
    fit
  );
};

/** `view` moved by (dx, dy) drawing units, kept inside the fit. */
export const panView = (view, fit, dx, dy) =>
  clampView({...view, x: view.x + dx, y: view.y + dy}, fit);

export const renderGraph = (layout, esc, href) => {
  const {x, y, w, h} = fitView(layout);
  const at = new Map(layout.nodes.map(n => [n.id, n]));
  const markers = TYPE_ORDER.map(
    t =>
      `<marker id="arrow-${t}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L10,5L0,10z" style="fill:${styleOf(t).color}"/></marker>`
  ).join('');
  const rings = layout.rings
    .map(ring => `<circle class="ring" cx="0" cy="0" r="${num(ring.radius)}"/>`)
    .join('');
  const nodes = layout.nodes
    .map(
      n =>
        `<a href="${esc(href(n.record))}"><g class="node${n.depth === 0 ? ' root' : ''}"><title>${esc(titleOf(n.record))} (${esc(n.record.file_path)})</title><circle cx="${num(n.x)}" cy="${num(n.y)}" r="${n.depth === 0 ? ROOT_R : NODE_R}"/>${label(n, esc)}</g></a>`
    )
    .join('');
  return `<svg class="graph" viewBox="${x} ${y} ${w} ${h}" role="img" aria-label="${esc(`${titleOf(at.get(layout.nodes[0].id).record)} and ${layout.nodes.length - 1} notes around it`)}"><defs>${markers}</defs>${rings}${layout.edges.map(e => line(e, at, esc)).join('')}${nodes}</svg>`;
};

/** The types drawn, each with its stroke and how many of its edges are drawn, in TYPE_ORDER. */
export const legendOf = layout =>
  TYPE_ORDER.map(t => ({
    type: t,
    ...styleOf(t),
    count: layout.edges.filter(e => e.type === t).length
  })).filter(s => s.count > 0);
