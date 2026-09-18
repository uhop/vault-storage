import test from 'tape-six';
import {Marked} from 'marked';
import {linkResolver, renderMarkdown} from '../src/render/render.ts';

const noLinks = (): null => null;

test('renderMarkdown stamps each top-level heading with its document line', t => {
  const body = [
    '# Title',
    '',
    'Text.',
    '',
    '```',
    '## not a heading',
    '```',
    '',
    '## Real',
    ''
  ].join('\n');
  const {html} = renderMarkdown(body, 5, noLinks);
  t.ok(html.includes('<h1 data-line="5">Title</h1>'), 'first line is the given start');
  t.ok(html.includes('<h2 data-line="13">Real</h2>'), 'lines count through the fence');
  t.notOk(html.includes('data-line="10"'), 'a heading inside a fence is code');
});

test('renderMarkdown is marked with gfm apart from the data-line attributes', t => {
  const body = [
    '# One',
    '',
    'A *b* `c` [d](https://example.com) ~~e~~',
    '',
    '| x | y |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '- [ ] task',
    '- item',
    '',
    '> quote',
    '',
    'Setext',
    '======',
    '',
    '<details><summary>s</summary>raw</details>',
    ''
  ].join('\n');
  const plain = new Marked({gfm: true, breaks: false}).parse(body) as string;
  const {html} = renderMarkdown(body, 1, noLinks);
  t.equal(html.replace(/ data-line="\d+"/g, ''), plain);
});

test('renderMarkdown resolves wikilinks and escapes what it writes', t => {
  const resolve = linkResolver([
    {recordId: 'r1', filePath: 'topics/alpha.md'},
    {recordId: 'r2', filePath: 'topics/a&b.md'}
  ]);
  const {html} = renderMarkdown(
    'See [[topics/alpha|Alpha]], [[topics/a&b]], and [[missing "one"]].',
    1,
    resolve
  );
  t.ok(
    html.includes(
      '<a class="wikilink" data-wikilink="topics/alpha" href="/ui/note.html?path=topics%2Falpha.md" title="topics/alpha.md">Alpha</a>'
    ),
    'resolved, alias displayed'
  );
  t.ok(
    html.includes(
      '<a class="wikilink" data-wikilink="topics/a&amp;b" href="/ui/note.html?path=topics%2Fa%26b.md" title="topics/a&amp;b.md">topics/a&amp;b</a>'
    ),
    'target, path, and display escaped'
  );
  t.ok(
    html.includes(
      '<a class="wikilink unresolved" data-wikilink="missing &quot;one&quot;" title="Wikilink not resolved">missing &quot;one&quot;</a>'
    ),
    'unresolved'
  );
  t.notOk(
    renderMarkdown('`[[topics/alpha]]`', 1, resolve).html.includes('<a '),
    'code is not a link'
  );
});

test('renderMarkdown lists the sections the section editor addresses', t => {
  const body = [
    '## A',
    'x',
    '### B',
    'y',
    '## A',
    'z',
    '',
    'Setext',
    '---',
    '```',
    '## fenced',
    '```'
  ].join('\n');
  const {html, sections} = renderMarkdown(body, 3, noLinks);
  t.deepEqual(sections, [
    {heading: '## A', level: 2, line: 3, occurrence: 0},
    {heading: '### B', level: 3, line: 5, occurrence: 0},
    {heading: '## A', level: 2, line: 7, occurrence: 1}
  ]);
  t.ok(html.includes('<h2 data-line="10">Setext</h2>'), 'a setext heading is stamped');
  t.notOk(
    sections.some(s => s.line === 10),
    'but is not a section: replace-section matches ATX lines only'
  );
});
