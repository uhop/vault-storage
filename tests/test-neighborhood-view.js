import test from 'tape-six';

import {
  arrangeHops,
  countEdgeTypes,
  countTypes,
  renderHops,
  SHOW_FIRST
} from '/static/ui/neighborhood-view.js';

const esc = s =>
  String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
const rec = (id, path, title = null) => ({record_id: id, file_path: path, title});

// root → a (derived-from), root → b (cites), a ↔ c (related-to, mirrored),
// b → d (cites), c → b (cites: a second edge between hop 1 and C).
const neighborhood = {
  layers: [
    {depth: 1, records: [rec('b', 't/b.md', 'B'), rec('a', 't/a.md', 'A')]},
    {depth: 2, records: [rec('d', 't/d.md', 'D'), rec('c', 't/c.md', 'C')]}
  ],
  edges: [
    {from_id: 'root', to_id: 'a', type: 'derived-from'},
    {from_id: 'root', to_id: 'b', type: 'cites'},
    {from_id: 'a', to_id: 'c', type: 'related-to'},
    {from_id: 'c', to_id: 'a', type: 'related-to'},
    {from_id: 'b', to_id: 'd', type: 'cites'},
    {from_id: 'c', to_id: 'b', type: 'cites'}
  ]
};

test('arrangeHops keeps each note at its first hop, with the edges that reached it', t => {
  const hops = arrangeHops('root', neighborhood);
  t.equal(hops.length, 2);
  t.deepEqual(
    hops[0].notes.map(n => n.record.title),
    ['A', 'B'],
    'hop 1 sorted by strongest type: derived-from before cites'
  );
  t.deepEqual(
    hops[0].notes[0].via,
    [{type: 'derived-from', direction: 'in', other: null}],
    'the root points at A'
  );
  t.deepEqual(
    hops[1].notes.map(n => n.record.title),
    ['C', 'D'],
    'hop 2: both cite, C by title'
  );
  const c = hops[1].notes.find(n => n.record.title === 'C');
  t.deepEqual(
    c.via.map(v => [v.type, v.direction, v.other.title]),
    [
      ['cites', 'out', 'B'],
      ['related-to', 'both', 'A']
    ],
    'C points at B, and the mirrored pair with A reads once as both'
  );
  t.deepEqual(countTypes(hops[1]), [
    ['cites', 2],
    ['related-to', 1]
  ]);
  t.deepEqual(arrangeHops('root', {layers: [], edges: []}), [], 'no layers, no hops');
});

test('renderHops writes one section per non-empty hop with counts, and folds past SHOW_FIRST', t => {
  const html = renderHops(arrangeHops('root', neighborhood), esc, 'Root');
  t.ok(html.includes('<h2>Hop 1 · 2 notes · derived-from 1 · cites 1</h2>'));
  t.ok(html.includes('derived-from</span> ← Root'), 'hop 1 names the root, pointing at A');
  t.ok(html.includes('related-to</span> ↔ A'), 'a mirrored edge names its other end');
  t.equal(
    renderHops(arrangeHops('root', {layers: [{depth: 1, records: []}], edges: []}), esc, 'Root'),
    '',
    'an empty hop renders nothing'
  );
  const n = SHOW_FIRST + 3;
  const many = {
    layers: [{depth: 1, records: Array.from({length: n}, (_, i) => rec(`n${i}`, `t/n${i}.md`))}],
    edges: Array.from({length: n}, (_, i) => ({from_id: 'root', to_id: `n${i}`, type: 'cites'}))
  };
  const folded = renderHops(arrangeHops('root', many), esc, 'Root');
  t.ok(folded.includes('<summary>3 more</summary>'), 'the tail folds');
  t.ok(folded.includes(`Hop 1 · ${n} notes · cites ${n}`));
});

test('countEdgeTypes counts a mirrored pair once and each directed edge', t => {
  t.deepEqual(countEdgeTypes(neighborhood.edges), {'derived-from': 1, cites: 3, 'related-to': 1});
  t.deepEqual(
    countEdgeTypes([
      {from_id: 'x', to_id: 'y', type: 'cites'},
      {from_id: 'y', to_id: 'x', type: 'cites'}
    ]),
    {cites: 2},
    'two directed edges between one pair are two'
  );
  t.deepEqual(countEdgeTypes(undefined), {});
});
