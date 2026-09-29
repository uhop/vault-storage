import test from 'tape-six';

import {
  groupLinks,
  renderLinks,
  renderWarnings,
  SHOW_FIRST,
  titleOf,
  warnings
} from '/static/ui/note-links.js';

const esc = s =>
  String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);

const rec = (id, path, title = null) => ({record_id: id, file_path: path, title});

const neighborhood = {
  layers: [
    {
      depth: 1,
      records: [
        rec('s', 'topics/successor.md', 'Successor'),
        rec('p', 'topics/parent.md', 'Parent'),
        rec('c1', 'topics/cited-b.md', 'Cited B'),
        rec('c2', 'topics/cited-a.md', 'Cited A'),
        rec('r', 'topics/related.md', null)
      ]
    }
  ],
  edges: [
    {from_id: 's', to_id: 'root', type: 'supersedes', weight: 1, note: null, created: 't'},
    {
      from_id: 'root',
      to_id: 'p',
      type: 'derived-from',
      weight: 1,
      note: 'per the review',
      created: 't'
    },
    {from_id: 'root', to_id: 'c1', type: 'cites', weight: 1, note: null, created: 't'},
    {from_id: 'root', to_id: 'c2', type: 'cites', weight: 1, note: null, created: 't'},
    {from_id: 'root', to_id: 'r', type: 'related-to', weight: 1, note: null, created: 't'},
    {from_id: 'r', to_id: 'root', type: 'related-to', weight: 1, note: null, created: 't'},
    {from_id: 'x', to_id: 'y', type: 'cites', weight: 1, note: null, created: 't'}
  ]
};

test('groupLinks orders types, splits direction, sorts by title, and lists a mirrored type once', t => {
  const groups = groupLinks('root', neighborhood);
  t.deepEqual(
    groups.map(g => g.type),
    ['supersedes', 'derived-from', 'cites', 'related-to'],
    'TYPE_ORDER, unknown types last'
  );
  const [sup, der, cites, rel] = groups;
  t.equal(sup.in.length, 1, 'the supersession points at this note');
  t.equal(sup.out.length, 0);
  t.equal(der.out[0].note, 'per the review', 'the edge note rides along');
  t.deepEqual(
    cites.out.map(r => r.title),
    ['Cited A', 'Cited B'],
    'sorted by title, not by edge order'
  );
  t.equal(rel.out.length, 1, 'a mirrored pair lists its neighbour once');
  t.equal(rel.in.length, 0);
  t.equal(titleOf(rel.out[0]), 'related', 'a note without a title reads as its file stem');
});

test('warnings names what supersedes or contradicts the note, and nothing else', t => {
  const groups = groupLinks('root', neighborhood);
  const w = warnings(groups);
  t.equal(w.length, 1);
  t.equal(w[0].type, 'supersedes');
  t.equal(w[0].records[0].title, 'Successor');
  t.equal(warnings(groupLinks('s', neighborhood)).length, 0, 'the successor itself has no warning');
  const html = renderWarnings(w, esc);
  t.ok(html.includes('Superseded by'), 'the notice reads as a sentence');
  t.ok(html.includes('note.html?path=topics%2Fsuccessor.md'), 'and links to the successor');
});

test('renderLinks counts each type in the summary, opens on a typed edge, and folds a long list', t => {
  const groups = groupLinks('root', neighborhood);
  const html = renderLinks(groups, esc);
  t.ok(html.startsWith('<details class="links" open>'), 'open: the note has typed edges');
  t.ok(html.includes('Links · supersedes 1 · derived-from 1 · cites 2 · related-to 1'));
  t.ok(html.includes('title="per the review"'), 'the edge note is the link title');
  t.ok(html.includes('<span class="arrow">←</span>'), 'inbound marked');
  t.ok(html.includes('<span class="arrow">↔</span>'), 'a mirrored type marked as such');

  const bulkOnly = groupLinks('root', {
    layers: [{depth: 1, records: Array.from({length: 12}, (_, i) => rec(`c${i}`, `t/c${i}.md`))}],
    edges: Array.from({length: 12}, (_, i) => ({from_id: 'root', to_id: `c${i}`, type: 'cites'}))
  });
  const folded = renderLinks(bulkOnly, esc);
  t.ok(folded.startsWith('<details class="links">'), 'closed: nothing but bulk types');
  t.ok(folded.includes(`<summary>${12 - SHOW_FIRST} more</summary>`), 'the rest folds');
  t.equal(renderLinks([], esc), '', 'no edges, no block');
});
