import test from 'tape-six';

import {arrangeHops} from '/static/ui/neighborhood-view.js';
import {
  fitView,
  layoutGraph,
  legendOf,
  MIN_ARC,
  panView,
  renderGraph,
  RING,
  ZOOM_MAX,
  zoomView
} from '/static/ui/neighborhood-graph.js';

const esc = s =>
  String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
const rec = (id, path, title = null) => ({record_id: id, file_path: path, title});
const root = rec('root', 't/root.md', 'Root');

// root → a (derived-from), root → b (cites), a ↔ c (related-to, mirrored),
// b → d (cites), c → b (cites), c → c (a self edge).
const neighborhood = {
  layers: [
    {depth: 1, records: [rec('b', 't/b.md', 'B'), rec('a', 't/a.md', 'A')]},
    {depth: 2, records: [rec('d', 't/d.md', 'D'), rec('c', 't/c.md', 'C <x>')]}
  ],
  edges: [
    {from_id: 'root', to_id: 'a', type: 'derived-from'},
    {from_id: 'root', to_id: 'b', type: 'cites'},
    {from_id: 'a', to_id: 'c', type: 'related-to'},
    {from_id: 'c', to_id: 'a', type: 'related-to'},
    {from_id: 'b', to_id: 'd', type: 'cites'},
    {from_id: 'c', to_id: 'b', type: 'cites'},
    {from_id: 'c', to_id: 'c', type: 'cites'}
  ]
};
const hops = arrangeHops('root', neighborhood);
const layout = layoutGraph('root', root, hops, neighborhood.edges);
const byId = new Map(layout.nodes.map(n => [n.id, n]));

test('layoutGraph puts the root at the center and hop d on ring d', t => {
  t.deepEqual([byId.get('root').x, byId.get('root').y], [0, 0]);
  const radius = new Map(layout.rings.map(r => [r.depth, r.radius]));
  for (const n of layout.nodes.filter(n => n.depth > 0)) {
    t.ok(Math.abs(Math.hypot(n.x, n.y) - radius.get(n.depth)) < 1e-6, `${n.id} on ring ${n.depth}`);
  }
  t.deepEqual(layout.rings, [
    {depth: 1, radius: RING},
    {depth: 2, radius: 2 * RING}
  ]);
  t.equal(layout.radius, 2 * RING);
  t.equal(layout.left, 0);
});

test('layoutGraph hangs each note under the first drawn note of its via', t => {
  t.equal(byId.get('a').parent, 'root');
  t.equal(byId.get('b').parent, 'root');
  t.equal(byId.get('d').parent, 'b');
  t.equal(byId.get('c').parent, 'b', 'cites ranks before related-to');
});

test('layoutGraph keeps the notes of a ring apart', t => {
  const many = {
    layers: [
      {
        depth: 1,
        records: Array.from({length: 70}, (_, i) => rec(`n${i}`, `t/n${i}.md`, `N${i}`))
      }
    ],
    edges: Array.from({length: 70}, (_, i) => ({from_id: 'root', to_id: `n${i}`, type: 'cites'}))
  };
  const crowded = layoutGraph('root', root, arrangeHops('root', many), many.edges, 80);
  const ring = crowded.nodes
    .filter(n => n.depth === 1)
    .map(n => n.angle)
    .sort((x, y) => x - y);
  const radius = crowded.rings[0].radius;
  t.ok(
    radius >= (ring.length * MIN_ARC) / (2 * Math.PI) - 1e-9,
    'the ring widens to fit its notes'
  );
  const gap = MIN_ARC / radius;
  t.ok(
    ring.every((a, i) => i === 0 || a - ring[i - 1] >= gap - 1e-9),
    'every neighbor at least the least arc apart'
  );
});

test('layoutGraph caps the drawing and never draws a note without its parent', t => {
  const capped = layoutGraph('root', root, hops, neighborhood.edges, 2);
  t.deepEqual(capped.nodes.map(n => n.id).sort(), ['a', 'b', 'root']);
  t.equal(capped.left, 2);
  t.ok(
    capped.edges.every(e => e.from !== 'c' && e.to !== 'c' && e.from !== 'd' && e.to !== 'd'),
    'edges only among drawn notes'
  );
});

test('layoutGraph draws a mirrored pair once, undirected, and drops a self edge', t => {
  const related = layout.edges.filter(e => e.type === 'related-to');
  t.equal(related.length, 1);
  t.equal(related[0].directed, false);
  t.ok(layout.edges.filter(e => e.type !== 'related-to').every(e => e.directed));
  t.notOk(
    layout.edges.some(e => e.from === e.to),
    'no self edge'
  );
  t.equal(layout.edges.length, 5);
});

test('renderGraph escapes titles, links each note, and arrows only directed edges', t => {
  const svg = renderGraph(layout, esc, r => `/n?path=${encodeURIComponent(r.file_path)}&x="1"`);
  t.ok(svg.startsWith('<svg class="graph"'));
  t.ok(svg.includes('C &lt;x&gt;'), 'title escaped');
  t.notOk(svg.includes('C <x>'));
  t.ok(svg.includes('href="/n?path=t%2Fc.md&amp;x=&quot;1&quot;"'), 'href escaped');
  t.equal(svg.match(/<a href=/g).length, 5, 'one link per note');
  t.equal(svg.match(/marker-end=/g).length, 4, 'an arrow per directed edge');
  t.equal(svg.match(/<circle class="ring"/g).length, 2);
});

test('legendOf lists the drawn types in their order, with how many of each are drawn', t => {
  t.deepEqual(
    legendOf(layout).map(s => [s.type, s.count]),
    [
      ['derived-from', 1],
      ['cites', 3],
      ['related-to', 1]
    ]
  );
  t.deepEqual(
    legendOf(layoutGraph('root', root, hops, neighborhood.edges, 2)).map(s => [s.type, s.count]),
    [
      ['derived-from', 1],
      ['cites', 1]
    ],
    'only the edges among the drawn notes'
  );
});

test('zoomView keeps the point it zooms about in place, between the fit and ZOOM_MAX', t => {
  const fit = fitView(layout);
  const r = layout.radius + 175;
  t.deepEqual(fit, {x: -r, y: -r, w: 2 * r, h: 2 * r});
  const at = {x: 100, y: -50};
  const view = zoomView(fit, fit, 2, at);
  t.equal(view.w, fit.w / 2);
  const before = {u: (at.x - fit.x) / fit.w, v: (at.y - fit.y) / fit.h};
  const after = {u: (at.x - view.x) / view.w, v: (at.y - view.y) / view.h};
  t.ok(
    Math.abs(before.u - after.u) < 1e-9 && Math.abs(before.v - after.v) < 1e-9,
    'the point stays put'
  );
  t.equal(zoomView(fit, fit, 100, at).w, fit.w / ZOOM_MAX, 'no closer than ZOOM_MAX');
  t.deepEqual(zoomView(view, fit, 0.1, at), fit, 'no farther than the fit');
});

test('panView moves a zoomed view and keeps it inside the fit', t => {
  const fit = fitView(layout);
  const view = zoomView(fit, fit, 4, {x: 0, y: 0});
  const moved = panView(view, fit, 20, -30);
  t.deepEqual([moved.x - view.x, moved.y - view.y], [20, -30]);
  const far = panView(view, fit, 1e6, -1e6);
  t.equal(far.x, fit.x + fit.w - view.w, 'stopped at the right edge');
  t.equal(far.y, fit.y, 'stopped at the top edge');
  t.deepEqual(panView(fit, fit, 40, 40), fit, 'a fitted view does not move');
});
