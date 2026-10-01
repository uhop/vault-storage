import test from 'tape-six';

import {
  cycle,
  edgeParam,
  facetRows,
  keyOf,
  parseEdgeParam,
  renderEdgeSummary,
  renderFacets,
  summarizeEdges
} from '/static/ui/search-edges.js';

const esc = s =>
  String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);

test('parseEdgeParam reads the facet conditions and keeps the others as written', t => {
  const {picks, extra} = parseEdgeParam(
    'supersedes:outbound,!cites:inbound,related-to|cites:both:x1'
  );
  t.deepEqual(
    [...picks],
    [
      ['supersedes out', 'has'],
      ['cites in', 'lacks']
    ]
  );
  t.deepEqual(extra, ['related-to|cites:both:x1']);
  t.equal(edgeParam(picks, extra), 'supersedes:outbound,!cites:inbound,related-to|cites:both:x1');
  t.equal(edgeParam(new Map()), '', 'nothing picked, no condition');
  t.deepEqual([...parseEdgeParam(null).picks], []);
});

test('cycle runs off, has, lacks, off', t => {
  t.deepEqual(
    [cycle(undefined), cycle('has'), cycle('lacks'), cycle('off')],
    ['has', 'lacks', 'off', 'has']
  );
});

test('facetRows keeps a picked row the counts no longer have, in type and direction order', t => {
  const rows = facetRows(
    [
      {type: 'related-to', direction: 'both', hits: 4},
      {type: 'supersedes', direction: 'in', hits: 1},
      {type: 'supersedes', direction: 'out', hits: 2}
    ],
    new Map([[keyOf('cites', 'out'), 'lacks']])
  );
  t.deepEqual(
    rows.map(r => `${r.type} ${r.direction} ${r.hits}`),
    ['supersedes out 2', 'supersedes in 1', 'cites out 0', 'related-to both 4']
  );
});

test('renderFacets marks each row by its state, disables an empty unpicked row, and offers a Clear', t => {
  const picks = new Map([[keyOf('supersedes', 'out'), 'has']]);
  const html = renderFacets(
    [
      {type: 'supersedes', direction: 'out', hits: 2},
      {type: 'revises', direction: 'out', hits: 0}
    ],
    picks,
    ['x<y'],
    7,
    esc
  );
  t.ok(html.includes('7 matches'));
  t.ok(html.includes('data-key="supersedes out" data-state="has"'));
  t.ok(
    /data-key="revises out" data-state="off" disabled/.test(html),
    'an empty row cannot be picked'
  );
  t.ok(html.includes('→'));
  t.ok(html.includes('also x&lt;y'), 'kept conditions escaped');
  t.ok(html.includes('facet-clear'));
  t.notOk(renderFacets([], new Map(), [], 1, esc).includes('facet-clear'), 'nothing to clear');
  t.ok(renderFacets([], new Map(), [], 1, esc).includes('1 match<'), 'one match');
});

test('summarizeEdges counts a hit edges by type and direction, and the summary marks what a pick matched', t => {
  const edges = [
    {type: 'cites', direction: 'out'},
    {type: 'cites', direction: 'out'},
    {type: 'supersedes', direction: 'both'},
    {type: 'related-to', direction: 'both'}
  ];
  const summary = summarizeEdges(edges);
  t.deepEqual(
    summary.map(s => `${s.type} ${s.direction} ${s.count}`),
    ['supersedes both 1', 'cites out 2', 'related-to both 1']
  );
  const html = renderEdgeSummary(
    summary,
    new Map([
      [keyOf('supersedes', 'in'), 'has'],
      [keyOf('cites', 'in'), 'lacks']
    ]),
    esc
  );
  t.ok(
    html.includes('<span class="edge match"><span class="type">supersedes</span> ↔ 1</span>'),
    'both meets in'
  );
  t.ok(
    html.includes('<span class="edge"><span class="type">cites</span> → 2</span>'),
    'a lacks pick marks nothing'
  );
  t.deepEqual(summarizeEdges(undefined), []);
});
