import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {renderMarkdown} from '../src/render/render.ts';
import {parseRef, resolveRefs, type ResolveRef} from '../src/render/refs.ts';
import {refResolver} from '../src/server/refs.ts';

const noLinks = (): null => null;
const marks = (body: string): string[] =>
  [...renderMarkdown(body, 1, noLinks).html.matchAll(/<span data-ref="([^"]+)">/g)].map(m => m[1]!);

test('renderMarkdown marks short references where they stand as words', t => {
  t.deepEqual(marks('See #233, uhop/stream-json#216, and ENG-42.'), [
    '#233',
    'uhop/stream-json#216',
    'ENG-42'
  ]);
  t.deepEqual(marks('#5 opens the line, and (#6) sits in brackets.'), ['#5', '#6']);
  t.deepEqual(marks('## Heading about #7'), ['#7'], 'a heading is text too');
  t.deepEqual(marks('| a |\n| - |\n| #8 |'), ['#8'], 'and so is a table cell');
  t.deepEqual(marks('**bold** #9 and **bold**#10'), ['#9', '#10'], 'markup is a boundary');
});

test('renderMarkdown leaves what only looks like a reference', t => {
  const kept = [
    'abc#5',
    'a/b/c#5',
    'v1.2#5',
    '`#5` and `ENG-42`',
    '```\n#5\n```',
    '[see #5](https://example.com)',
    'https://example.com/page#5',
    '<a href="#5">x</a>',
    '&#5;',
    '#0 and #05',
    '#5x',
    'eng-42, E-42, and X-ENG-42',
    'ENG-42x',
    '**ab**c#5',
    '`code`s#5',
    '[[topics/a#5]]'
  ];
  for (const body of kept) t.deepEqual(marks(body), [], body);
});

test('parseRef reads both shapes', t => {
  t.deepEqual(parseRef('#233'), {kind: 'number', repo: null, n: 233});
  t.deepEqual(parseRef('uhop/stream-json#216'), {
    kind: 'number',
    repo: 'uhop/stream-json',
    n: 216
  });
  t.deepEqual(parseRef('ENG-42'), {kind: 'key', prefix: 'ENG', n: 42});
  t.equal(parseRef('nonsense'), null);
});

test('resolveRefs links what resolves and leaves the rest as text', t => {
  const resolve: ResolveRef = ref =>
    ref.kind === 'number' && ref.n === 1
      ? {url: 'https://example.com/1?a=1&b=2', title: 'Fix <b> & "quotes"', state: 'closed'}
      : ref.kind === 'key'
        ? {url: 'https://linear.app/acme/issue/ENG-42', title: null, state: null}
        : null;
  const {html} = renderMarkdown('One #1, two #2, key ENG-42.', 1, noLinks);
  t.equal(
    resolveRefs(html, resolve),
    '<p>One <a class="ref" href="https://example.com/1?a=1&amp;b=2" data-state="closed">#1 Fix &lt;b&gt; &amp; &quot;quotes&quot;</a>, two #2, key <a class="ref" href="https://linear.app/acme/issue/ENG-42">ENG-42</a>.</p>\n'
  );
  t.equal(
    resolveRefs('<p>plain</p>', () => null),
    '<p>plain</p>'
  );
});

const vault = (files: Record<string, string>): {root: string; cleanup: () => void} => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-refs-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), {recursive: true});
    writeFileSync(join(root, path), text);
  }
  return {root, cleanup: () => rmSync(root, {recursive: true, force: true})};
};

const state = (repo: string, items: Record<string, unknown>): string =>
  [
    '---',
    'title: State',
    '---',
    '## Baseline snapshot',
    '',
    '```json',
    '{"repo": "not-this-block"}',
    '```',
    '',
    '## GitHub',
    '',
    'Auto-maintained.',
    '',
    '```json',
    JSON.stringify({repo, items}, null, 2),
    '```',
    ''
  ].join('\n');

const queue = (trackers: string[]): string =>
  ['---', 'title: Queue', ...trackers, '---', '## Active', '', '(empty)', ''].join('\n');

test('refResolver: a project note resolves against its repository and the stored titles', t => {
  const {root, cleanup} = vault({
    'projects/alpha/queue.md': queue([]),
    'projects/alpha/state.md': state('uhop/alpha', {
      '5': {
        title: 'Five',
        state: 'open',
        html_url: 'https://github.com/uhop/alpha/pull/5'
      },
      '6': {title: 'Six', html_url: 'javascript:alert(1)'}
    }),
    'projects/beta/state.md': state('uhop/Beta', {'9': {title: 'Nine', state: 'closed'}}),
    'projects/gamma/queue.md': queue([])
  });
  try {
    const alpha = refResolver(root, 'projects/alpha/decisions.md');
    t.deepEqual(alpha({kind: 'number', repo: null, n: 5}), {
      url: 'https://github.com/uhop/alpha/pull/5',
      title: 'Five',
      state: 'open'
    });
    t.deepEqual(
      alpha({kind: 'number', repo: null, n: 6}),
      {url: 'https://github.com/uhop/alpha/issues/6', title: 'Six', state: null},
      'a stored URL that is not https is replaced'
    );
    t.deepEqual(
      alpha({kind: 'number', repo: null, n: 7}),
      {url: 'https://github.com/uhop/alpha/issues/7', title: null, state: null},
      'an item the baseline lacks still links'
    );
    t.deepEqual(
      alpha({kind: 'number', repo: 'uhop/alpha', n: 5})?.title,
      'Five',
      'the qualified form of its own repository'
    );
    t.deepEqual(
      alpha({kind: 'number', repo: 'uhop/beta', n: 9}),
      {url: 'https://github.com/uhop/Beta/issues/9', title: 'Nine', state: 'closed'},
      'another project the vault knows, whatever the case'
    );
    t.deepEqual(
      alpha({kind: 'number', repo: 'someone/else', n: 3}),
      {url: 'https://github.com/someone/else/issues/3', title: null, state: null},
      'an unknown repository links, since the project is on GitHub'
    );
    t.equal(alpha({kind: 'key', prefix: 'ENG', n: 1}), null, 'no tracker declares the key');

    const topic = refResolver(root, 'topics/note.md');
    t.equal(topic({kind: 'number', repo: null, n: 5}), null, 'outside a project #N means nothing');
    t.equal(topic({kind: 'number', repo: 'uhop/beta', n: 9})?.title, 'Nine', 'a known one links');
    t.equal(topic({kind: 'number', repo: 'someone/else', n: 3}), null, 'an unknown one does not');
    t.equal(topic({kind: 'number', repo: 'uhop/..', n: 1}), null, 'no path leaves projects/');

    const gamma = refResolver(root, 'projects/gamma/queue.md');
    t.equal(gamma({kind: 'number', repo: null, n: 5}), null, 'a project with no repository');
    t.equal(refResolver(root, null)({kind: 'number', repo: null, n: 5}), null, 'no note path');
  } finally {
    cleanup();
  }
});

test('refResolver: the declared trackers name the repository and the keys', t => {
  const {root, cleanup} = vault({
    'projects/alpha/queue.md': queue([
      'trackers:',
      '  - kind: github',
      '    ref: acme/alpha',
      '    role: mirror',
      '  - kind: linear',
      '    ref: ENG',
      '    role: primary',
      '    url: https://linear.app/acme/team/ENG/active',
      '  - kind: jira',
      '    ref: OPS',
      '    role: mirror',
      '    url: https://acme.atlassian.net/jira/software/projects/OPS',
      '  - kind: jira',
      '    ref: NOURL',
      '    role: mirror'
    ]),
    'projects/alpha/state.md': state('uhop/alpha', {'5': {title: 'Five'}})
  });
  try {
    const alpha = refResolver(root, 'projects/alpha/learnings.md');
    t.deepEqual(
      alpha({kind: 'number', repo: null, n: 5}),
      {url: 'https://github.com/acme/alpha/issues/5', title: null, state: null},
      'the declaration wins, and the titles of another repository do not apply'
    );
    t.deepEqual(alpha({kind: 'key', prefix: 'ENG', n: 42}), {
      url: 'https://linear.app/acme/issue/ENG-42',
      title: null,
      state: null
    });
    t.deepEqual(alpha({kind: 'key', prefix: 'OPS', n: 7}), {
      url: 'https://acme.atlassian.net/browse/OPS-7',
      title: null,
      state: null
    });
    t.equal(alpha({kind: 'key', prefix: 'NOURL', n: 1}), null, 'a key with no URL cannot link');
    t.equal(alpha({kind: 'key', prefix: 'UTF', n: 8}), null, 'an undeclared key is text');
  } finally {
    cleanup();
  }
});
