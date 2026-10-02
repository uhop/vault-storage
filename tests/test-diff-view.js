import test from 'tape-six';

import {parseWordDiff, renderWordDiff} from '/static/ui/diff-view.js';

const esc = s =>
  String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);

const doc = html => new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');

// What git's --word-diff=porcelain printed for the route's test notes.
const WORDS = [
  '--- aaaaaaaa:topics/a.md',
  '+++ topics/b.md',
  '@@ -1,4 +1,4 @@',
  ' tags: [x, ',
  '-y]',
  '+z]',
  '~',
  ' The second version, ',
  '-edited.',
  '+edited <and> moved.',
  '~',
  '-Old line gone.',
  '~',
  '~',
  '@@ -12 +12,2 @@',
  '+A new line.',
  '~',
  '\\ No newline at end of file',
  ''
].join('\n');

test('diff view: hunks, lines, and runs from the porcelain', t => {
  const hunks = parseWordDiff(WORDS);
  t.deepEqual(
    hunks.map(h => [h.from, h.to, h.lines.length]),
    [
      [1, 1, 4],
      [12, 12, 1]
    ]
  );
  t.deepEqual(hunks[0].lines[0], [
    [' ', 'tags: [x, '],
    ['-', 'y]'],
    ['+', 'z]']
  ]);
  t.deepEqual(hunks[0].lines[3], [], 'an empty line is kept');
  t.deepEqual(parseWordDiff(''), [], 'no differences');
});

test('diff view: words marked, whole lines classed, text escaped', t => {
  const html = doc(renderWordDiff(WORDS, esc));
  t.deepEqual(
    [...html.querySelectorAll('.hunk-head')].map(h => h.textContent),
    ['Line 1', 'Line 12']
  );
  const lines = [...html.querySelectorAll('.dl')];
  t.equal(lines[0].querySelector('del').textContent, 'y]');
  t.equal(lines[0].querySelector('ins').textContent, 'z]');
  t.equal(lines[0].className, 'dl', 'a changed line is not classed');
  t.equal(lines[1].querySelector('ins').textContent, 'edited <and> moved.');
  t.equal(lines[2].className, 'dl removed');
  t.equal(lines[4].className, 'dl added');
  t.matchString(
    doc(renderWordDiff('@@ -1,2 +0,0 @@\n-gone\n~\n', esc)).querySelector('.hunk-head').textContent,
    /^Line 1$/,
    'a hunk that removes everything starts on the older side'
  );
  t.equal(doc(renderWordDiff('', esc)).querySelector('.empty').textContent, 'No differences.');
});
