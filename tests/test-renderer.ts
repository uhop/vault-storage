import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {importVault} from '../src/importer/import.ts';
import {MarkdownRenderer, RenderTimeoutError} from '../src/render/renderer.ts';
import {ResolverCache} from '../src/server/resolver-cache.ts';

const paths = (version: number, filePaths: string[]) => ({
  version,
  entries: filePaths.map((filePath, i) => ({recordId: `r${i}`, filePath}))
});

test('MarkdownRenderer renders on a worker and caches by body, start line, and path version', async t => {
  const renderer = new MarkdownRenderer();
  try {
    const body = '# Hi\n\nSee [[topics/a]].\n';
    const first = await renderer.render(body, 1, paths(1, []));
    t.ok(first.html.includes('<h1 data-line="1">Hi</h1>'));
    t.ok(first.html.includes('wikilink unresolved'), 'nothing to resolve against');
    t.deepEqual(first.sections, [{heading: '# Hi', level: 1, line: 1, occurrence: 0}]);
    t.ok(renderer.threadId !== null, 'a worker runs');

    await renderer.render(body, 1, paths(1, []));
    t.equal(renderer.workerRenders, 1, 'same body, line, and version: cached');

    await renderer.render(body, 4, paths(1, []));
    t.equal(renderer.workerRenders, 2, 'a different start line renders again');

    const resolved = await renderer.render(body, 1, paths(2, ['topics/a.md']));
    t.equal(renderer.workerRenders, 3, 'a new path version renders again');
    t.ok(
      resolved.html.includes('href="/ui/note.html?path=topics%2Fa.md"'),
      'against the new paths'
    );
  } finally {
    await renderer.terminate();
  }
});

test('MarkdownRenderer replaces a worker past the time limit and caches no failure', async t => {
  const renderer = new MarkdownRenderer({timeoutMs: 1});
  try {
    const body = '# Big\n\n' + 'Some *text* with [a link](https://example.com).\n\n'.repeat(20_000);
    await t.rejects(renderer.render(body, 1, paths(1, [])), RenderTimeoutError);
    t.equal(renderer.threadId, null, 'the stalled worker is gone');
    await t.rejects(renderer.render(body, 1, paths(1, [])), RenderTimeoutError);
    t.equal(renderer.workerRenders, 2, 'the failure was not cached');
  } finally {
    await renderer.terminate();
  }
});

test('MarkdownRenderer.terminate rejects a pending render', async t => {
  const renderer = new MarkdownRenderer();
  const pending = renderer.render('# x\n', 1, paths(1, []));
  await renderer.terminate();
  await t.rejects(pending);
  t.equal(renderer.threadId, null);
});

test('ResolverCache moves its version only when the path set changes', t => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-resolver-cache-'));
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  const note = (name: string, body: string): void =>
    writeFileSync(join(root, 'topics', name), `---\ntitle: ${name}\n---\n${body}\n`, 'utf8');
  try {
    mkdirSync(join(root, 'topics'));
    note('a.md', 'A.');
    importVault(db, root);
    const cache = new ResolverCache(db);
    const v1 = cache.get().version;
    note('a.md', 'A, edited.');
    importVault(db, root);
    cache.invalidate();
    t.equal(cache.get().version, v1, 'an edit keeps the version');
    note('b.md', 'B.');
    importVault(db, root);
    cache.invalidate();
    t.notEqual(cache.get().version, v1, 'a new path moves it');
    t.deepEqual(
      cache.get().entries.map(e => e.filePath),
      ['topics/a.md', 'topics/b.md']
    );
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});
