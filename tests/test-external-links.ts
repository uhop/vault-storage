import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import {extractMentions, linkKey, normalizeKey, sourceKey} from '../src/links/external.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-links';

test('linkKey: a vendor object where the URL has its shape, else the normalized URL', t => {
  const cases: Array<[string, string | null]> = [
    ['https://github.com/uhop/Node-RE2/issues/233', 'github uhop/node-re2#233'],
    ['https://github.com/uhop/node-re2/pull/286/files', 'github uhop/node-re2#286'],
    ['https://github.com/uhop/node-re2/discussions/89', 'github uhop/node-re2 discussion#89'],
    [
      'https://github.com/uhop/node-re2/security/advisories/GHSA-579H-gqq2-r8cx',
      'github uhop/node-re2 GHSA-579h-gqq2-r8cx'
    ],
    ['https://github.com/uhop/node-re2', 'url https://github.com/uhop/node-re2'],
    ['https://gitlab.com/group/sub/proj/-/issues/12', 'gitlab group/sub/proj#12'],
    ['https://gitlab.com/group/proj/-/merge_requests/3', 'gitlab group/proj!3'],
    ['https://gitlab.com/group/proj/-/work_items/4', 'gitlab group/proj#4'],
    ['https://bitbucket.org/ws/Repo/pull-requests/7', 'bitbucket ws/repo!7'],
    ['https://bitbucket.org/ws/repo/issues/8', 'bitbucket ws/repo#8'],
    ['https://www.figma.com/design/AbC123/Checkout?node-id=12-345', 'figma AbC123'],
    ['https://www.figma.com/board/XyZ/Retro', 'figma XyZ'],
    ['https://acme.sentry.io/issues/123456/', 'sentry acme/123456'],
    ['https://sentry.io/organizations/acme/issues/99/', 'sentry acme/99'],
    [
      'https://acme.slack.com/archives/C0123/p1759000000123456',
      'slack acme/C0123/p1759000000123456'
    ],
    ['https://linear.app/acme/issue/ENG-123/some-title', 'linear ENG-123'],
    ['https://acme.atlassian.net/browse/VS-7', 'jira VS-7'],
    ['HTTPS://Example.COM/a/b/?q=1#frag', 'url https://example.com/a/b?q=1'],
    ['https://example.com/', 'url https://example.com'],
    ['http://croc.lan:8123/ui/note.html?path=x', 'url http://croc.lan:8123/ui/note.html?path=x'],
    ['ftp://example.com/x', null],
    ['not a url', null]
  ];
  for (const [url, key] of cases) t.equal(linkKey(url), key, url);
});

test('sourceKey and normalizeKey: the source spellings', t => {
  t.equal(sourceKey('github UHOP/x#5'), 'github uhop/x#5');
  t.equal(sourceKey('github uhop/x discussion#9'), 'github uhop/x discussion#9');
  t.equal(sourceKey('github uhop/x GHSA-aaaa-bbbb-cccc'), 'github uhop/x GHSA-aaaa-bbbb-cccc');
  t.equal(sourceKey('linear ENG-123'), 'linear ENG-123');
  t.equal(sourceKey('the survey'), null, 'prose is not a source');
  t.equal(normalizeKey('  github   UHOP/x#5 '), 'github uhop/x#5');
  t.equal(normalizeKey('figma   AbC123'), 'figma AbC123', 'a vendor key keeps its case');
});

test('extractMentions: URLs, references, and source lines, never in code', t => {
  const body = [
    'See [the frame](https://www.figma.com/design/AbC/Checkout?node-id=1-2), and',
    '<https://acme.sentry.io/issues/42/>. Also https://en.wikipedia.org/wiki/Foo_(bar).',
    'Tracked as #5 and uhop/other#6; not abc#7, a/b/c#8, or &#9;.',
    '`#10` and `https://example.com/code` are code.',
    '```',
    'https://example.com/fenced #11',
    '```',
    '  - source: github uhop/x discussion#12'
  ].join('\n');
  const keys = (path: string, project: string | null): string[] =>
    extractMentions(path, body, project)
      .map(m => `${m.key} | ${m.raw}`)
      .sort();
  t.deepEqual(keys('projects/p/notes/a.md', 'p'), [
    '#5 | #5',
    'figma AbC | https://www.figma.com/design/AbC/Checkout?node-id=1-2',
    'github uhop/other#6 | uhop/other#6',
    'sentry acme/42 | https://acme.sentry.io/issues/42/',
    'url https://en.wikipedia.org/wiki/Foo_(bar) | https://en.wikipedia.org/wiki/Foo_(bar)'
  ]);
  t.notOk(
    keys('topics/a.md', null).some(k => k.startsWith('#')),
    'a bare reference outside a project means nothing'
  );
  t.ok(
    keys('projects/p/queue.md', 'p').includes(
      'github uhop/x discussion#12 | github uhop/x discussion#12'
    ),
    'a queue file reads its source lines'
  );
  const queue = extractMentions(
    'projects/p/queue.md',
    '- **Item.** body\n  - source: github uhop/x#15\n',
    'p'
  );
  t.deepEqual(
    queue.map(m => [m.key, m.raw]),
    [['github uhop/x#15', 'github uhop/x#15']],
    'a source line counts once, not again as a reference'
  );
});

const makeEnv = (vaultDataPath: string): ServerEnv => ({
  vaultDataPath,
  vaultIngestPath: null,
  vaultDbPath: ':memory:',
  apiToken: TEST_TOKEN,
  host: '127.0.0.1',
  port: 0,
  autoReindex: false,
  autoWatch: false,
  watchDebounceMs: 1500,
  embedder: 'fake',
  embedderRetentionMs: 1_800_000,
  embedderMaxBatch: 8,
  autoCommit: false,
  autoPush: false,
  commitIntervalMs: 60000,
  commitIntervalMaxMs: 0,
  workHoursStart: null,
  workHoursEnd: null,
  gitAuthorName: 'vault-storage',
  gitAuthorEmail: 'vault-storage@localhost',
  uiStaticPath: '',
  embedAnomalyLogPath: '',
  memoryReportIntervalMs: 0
});

const writeMd = (root: string, path: string, content: string): void => {
  mkdirSync(dirname(join(root, path)), {recursive: true});
  writeFileSync(join(root, path), content);
};
const note = (title: string, body: string, type = 'permanent'): string =>
  ['---', `title: ${title}`, `type: ${type}`, '---', body, ''].join('\n');

interface Ctx {
  root: string;
  db: DatabaseSync;
  handle: ServerHandle;
  url: string;
}

const start = async (): Promise<Ctx> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-links-'));
  writeMd(
    root,
    'projects/alpha/state.md',
    [
      '---',
      'title: alpha — State',
      'type: state',
      '---',
      '## GitHub',
      '',
      '```json',
      JSON.stringify({repo: 'uhop/Alpha', collected_at: '2026-09-30T01:00:00Z', items: {}}),
      '```',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'projects/beta/queue.md',
    [
      '---',
      'title: beta — Queue',
      'type: project',
      'trackers:',
      '  - kind: github',
      '    ref: uhop/Beta-Repo',
      '    role: secondary',
      '---',
      '## Active',
      '',
      '- **Review alpha five.** read it first',
      '  - source: github uhop/alpha#5',
      '- **Unrelated.** nothing outside',
      '',
      '## Backlog',
      '',
      '## Watching',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'projects/alpha/notes/design.md',
    note(
      'Design',
      'Fixes #5. The frame: https://www.figma.com/design/AbC/Checkout?node-id=1-2 and https://Example.com/a/?q=1#frag'
    )
  );
  writeMd(root, 'projects/beta/notes/x.md', note('Beta note', 'See #7 and uhop/alpha#5.'));
  writeMd(
    root,
    'topics/t.md',
    note('Topic', 'Upstream: https://github.com/uhop/alpha/issues/5, and #9 means nothing here.')
  );
  writeMd(root, 'logs/2026-09-30-alpha-x.md', note('Alpha log', 'Worked on #6.', 'log'));
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, root);
  const handle = await startServer({
    db,
    env: makeEnv(root),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {root, db, handle, url: `http://127.0.0.1:${port}`};
};

const stop = async (ctx: Ctx): Promise<void> => {
  await ctx.handle.close();
  ctx.db.close();
  rmSync(ctx.root, {recursive: true, force: true});
};

const get = async (url: string, init: RequestInit = {}): Promise<{status: number; body: any}> => {
  const res = await fetch(url, {
    ...init,
    headers: {Authorization: `Bearer ${TEST_TOKEN}`, ...(init.headers ?? {})}
  });
  const text = await res.text();
  return {status: res.status, body: text ? JSON.parse(text) : null};
};

const paths = (entry: any): string[] => entry.mentions.map((m: any) => m.file_path);

test('GET /links: the notes and queue items that mention an object', async t => {
  const ctx = await start();
  try {
    const five = await get(`${ctx.url}/links?key=${encodeURIComponent('github UHOP/Alpha#5')}`);
    t.equal(five.status, 200);
    t.equal(five.body.key, 'github uhop/alpha#5', 'the key comes back in the index spelling');
    t.deepEqual(paths(five.body.links[0]), [
      'projects/alpha/notes/design.md',
      'projects/beta/notes/x.md',
      'projects/beta/queue.md',
      'topics/t.md'
    ]);
    const byPath = new Map(five.body.links[0].mentions.map((m: any) => [m.file_path, m]));
    t.deepEqual(
      (byPath.get('projects/alpha/notes/design.md') as any).raw,
      ['#5'],
      'a bare #5 in alpha'
    );
    t.deepEqual(
      (byPath.get('projects/beta/queue.md') as any).queue_items,
      [{title: 'Review alpha five.', section: 'active'}],
      'the queue item that holds the source'
    );
    t.equal(five.body.links[0].url, 'https://github.com/uhop/alpha/issues/5');

    const byUrl = await get(
      `${ctx.url}/links?url=${encodeURIComponent('https://github.com/uhop/alpha/pull/5')}`
    );
    t.equal(byUrl.body.key, 'github uhop/alpha#5', 'a URL finds the same object');
    t.equal(byUrl.body.links[0].mentions.length, 4);

    const figma = await get(`${ctx.url}/links?key=${encodeURIComponent('figma AbC')}`);
    t.deepEqual(paths(figma.body.links[0]), ['projects/alpha/notes/design.md']);
    t.ok(figma.body.links[0].url.endsWith('node-id=1-2'), 'the frame stays in the stored URL');
    const plain = await get(
      `${ctx.url}/links?url=${encodeURIComponent('https://example.com/a?q=1')}`
    );
    t.deepEqual(paths(plain.body.links[0]), ['projects/alpha/notes/design.md']);

    const alpha = await get(`${ctx.url}/links?repo=uhop/alpha`);
    t.deepEqual(
      alpha.body.links.map((l: any) => [l.key, paths(l).length]),
      [
        ['github uhop/alpha#5', 4],
        ['github uhop/alpha#6', 1]
      ],
      'every thread of the repository, the log counted through its project'
    );
    const beta = await get(`${ctx.url}/links?repo=UHOP/beta-repo`);
    t.deepEqual(
      beta.body.links.map((l: any) => [l.key, paths(l)]),
      [['github uhop/beta-repo#7', ['projects/beta/notes/x.md']]],
      'a declared tracker resolves a bare reference with no baseline'
    );
    const none = await get(`${ctx.url}/links?key=${encodeURIComponent('github uhop/alpha#404')}`);
    t.deepEqual(none.body.links, [{key: 'github uhop/alpha#404', url: null, mentions: []}]);

    for (const q of ['', 'key=a&repo=b/c', 'repo=nope', 'url=ftp://x/y', 'key=', 'x=1']) {
      t.equal((await get(`${ctx.url}/links?${q}`)).status, 400, `"${q}" is a 400`);
    }

    // A move changes the project, so the bare #5 now belongs to beta's repository.
    const moved = await get(`${ctx.url}/vault/move`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        from: 'projects/alpha/notes/design.md',
        to: 'projects/beta/notes/design.md'
      })
    });
    t.equal(moved.status, 204);
    t.deepEqual(
      paths((await get(`${ctx.url}/links?repo=uhop/beta-repo`)).body.links[0]),
      ['projects/beta/notes/design.md'],
      'the moved note’s #5 is beta-repo#5'
    );
    const logMoved = await get(`${ctx.url}/vault/move`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({from: 'logs/2026-09-30-alpha-x.md', to: 'logs/2026-09-30-beta-x.md'})
    });
    t.equal(logMoved.status, 204);
    t.equal(
      (
        ctx.db
          .prepare(`SELECT project FROM records WHERE file_path = 'logs/2026-09-30-beta-x.md'`)
          .get() as {project: string}
      ).project,
      'beta',
      'a renamed log takes the project its new name gives'
    );

    const written = await get(`${ctx.url}/vault/topics/new.md`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        frontmatter: {title: 'New', type: 'permanent'},
        body: 'Mentions https://github.com/uhop/alpha/issues/5 too.'
      })
    });
    t.equal(written.status, 204);
    t.ok(
      paths((await get(`${ctx.url}/links?key=github%20uhop/alpha%235`)).body.links[0]).includes(
        'topics/new.md'
      ),
      'a write indexes its mentions'
    );
    const gone = await get(`${ctx.url}/vault/topics/new.md`, {method: 'DELETE'});
    t.equal(gone.status, 204);
    t.notOk(
      paths((await get(`${ctx.url}/links?key=github%20uhop/alpha%235`)).body.links[0]).includes(
        'topics/new.md'
      ),
      'a delete takes its rows along'
    );
  } finally {
    await stop(ctx);
  }
});
