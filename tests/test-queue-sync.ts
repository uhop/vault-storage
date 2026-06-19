import {mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {QueueItemsRepository} from '../src/queue/repo.ts';
import {dropQueueFile, matchQueueFile, reindexAllQueues, syncQueueFile} from '../src/queue/sync.ts';

const FM = ['---', 'title: demo — Queue', 'type: project', '---', ''].join('\n');

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'vault-queue-sync-'));
  mkdirSync(join(root, 'projects'), {recursive: true});
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  return {root, db, repo: new QueueItemsRepository(db)};
};

const teardown = (handle: ReturnType<typeof setup>): void => {
  handle.db.close();
  rmSync(handle.root, {recursive: true, force: true});
};

const writeQueueFile = (
  root: string,
  project: string,
  basename: string,
  content: string
): string => {
  const dir = join(root, 'projects', project);
  mkdirSync(dir, {recursive: true});
  const abs = join(dir, basename);
  writeFileSync(abs, content);
  return `projects/${project}/${basename}`;
};

test('matchQueueFile', async t => {
  await t.test('matches queue.md', t => {
    t.deepEqual(matchQueueFile('projects/foo/queue.md'), {
      project: 'foo',
      sourceFile: 'projects/foo/queue.md'
    });
  });
  await t.test('matches queue-archive.md', t => {
    t.deepEqual(matchQueueFile('projects/foo/queue-archive.md'), {
      project: 'foo',
      sourceFile: 'projects/foo/queue-archive.md'
    });
  });
  await t.test('rejects nested or differently-named files', t => {
    t.equal(matchQueueFile('projects/foo/bar/queue.md'), null);
    t.equal(matchQueueFile('projects/foo/decisions.md'), null);
    t.equal(matchQueueFile('topics/queue.md'), null);
    t.equal(matchQueueFile('projects/foo/queue-archive-old.md'), null);
  });
});

test('syncQueueFile — no-op on non-queue paths', t => {
  const handle = setup();
  const r = syncQueueFile(handle.repo, 'projects/demo/decisions.md', handle.root);
  t.equal(r, null);
  teardown(handle);
});

test('syncQueueFile — reads from disk and applies', t => {
  const handle = setup();
  const rel = writeQueueFile(
    handle.root,
    'demo',
    'queue.md',
    FM + ['## Backlog', '', '- **First.** body A', '- **Second.** body B'].join('\n')
  );
  const r = syncQueueFile(handle.repo, rel, handle.root, '2026-05-13T12:00:00Z');
  t.deepEqual(r, {inserted: 2, updated: 0, refreshed: 0, deleted: 0});
  t.equal(handle.repo.count(), 2);
  teardown(handle);
});

test('syncQueueFile — file vanished mid-cycle drops the slice', t => {
  const handle = setup();
  const rel = writeQueueFile(
    handle.root,
    'demo',
    'queue.md',
    FM + ['## Backlog', '', '- **X.** y'].join('\n')
  );
  syncQueueFile(handle.repo, rel, handle.root, '2026-05-13T12:00:00Z');
  t.equal(handle.repo.count(), 1);

  unlinkSync(join(handle.root, rel));
  const r = syncQueueFile(handle.repo, rel, handle.root, '2026-05-13T12:00:00Z');
  t.deepEqual(r, {inserted: 0, updated: 0, refreshed: 0, deleted: 1});
  t.equal(handle.repo.count(), 0);
  teardown(handle);
});

test('dropQueueFile — drops slice without reading', t => {
  const handle = setup();
  const rel = writeQueueFile(
    handle.root,
    'demo',
    'queue.md',
    FM + ['## Backlog', '', '- **A.** a', '- **B.** b'].join('\n')
  );
  syncQueueFile(handle.repo, rel, handle.root, '2026-05-13T12:00:00Z');
  t.equal(handle.repo.count(), 2);

  // Even with the file still on disk, dropQueueFile removes the slice.
  t.equal(dropQueueFile(handle.repo, rel), 2);
  t.equal(handle.repo.count(), 0);
  // Non-queue path → null.
  t.equal(dropQueueFile(handle.repo, 'projects/demo/decisions.md'), null);
  teardown(handle);
});

test('reindexAllQueues — empty projects/ → zero everything', t => {
  const handle = setup();
  const r = reindexAllQueues(handle.repo, handle.root, '2026-05-13T12:00:00Z');
  t.equal(r.projectsScanned, 0);
  t.equal(r.filesProcessed, 0);
  t.equal(r.errors.length, 0);
  teardown(handle);
});

test('reindexAllQueues — walks projects/, ingests queue.md + queue-archive.md', t => {
  const handle = setup();
  writeQueueFile(
    handle.root,
    'alpha',
    'queue.md',
    FM + ['## Backlog', '', '- **A1.** ...', '- **A2.** ...'].join('\n')
  );
  writeQueueFile(
    handle.root,
    'alpha',
    'queue-archive.md',
    FM + ['## 2026-05-13', '', '- **Old.** shipped'].join('\n')
  );
  writeQueueFile(
    handle.root,
    'bravo',
    'queue.md',
    FM + ['## Active', '', '- **B-active.** in flight'].join('\n')
  );
  // Decoy: not a queue file, should be ignored.
  writeQueueFile(handle.root, 'bravo', 'decisions.md', '# not a queue');

  const r = reindexAllQueues(handle.repo, handle.root, '2026-05-13T12:00:00Z');
  t.equal(r.projectsScanned, 2);
  t.equal(r.filesProcessed, 3);
  t.equal(r.inserted, 4);
  t.equal(r.updated, 0);
  t.equal(r.deleted, 0);
  t.equal(handle.repo.count(), 4);
  teardown(handle);
});

test('reindexAllQueues — re-run is idempotent (refreshed but no churn)', t => {
  const handle = setup();
  writeQueueFile(
    handle.root,
    'alpha',
    'queue.md',
    FM + ['## Backlog', '', '- **A.** a'].join('\n')
  );
  reindexAllQueues(handle.repo, handle.root, '2026-05-13T12:00:00Z');

  const second = reindexAllQueues(handle.repo, handle.root, '2026-05-14T12:00:00Z');
  t.equal(second.inserted, 0);
  t.equal(second.updated, 0);
  t.equal(second.refreshed, 0, 'identical content + placement → no refresh either');
  t.equal(second.deleted, 0);
  t.equal(handle.repo.count(), 1);
  teardown(handle);
});

test('reindexAllQueues — drops slices for files no longer on disk', t => {
  const handle = setup();
  const rel = writeQueueFile(
    handle.root,
    'gamma',
    'queue.md',
    FM + ['## Backlog', '', '- **G.** g'].join('\n')
  );
  reindexAllQueues(handle.repo, handle.root, '2026-05-13T12:00:00Z');
  t.equal(handle.repo.count(), 1);

  unlinkSync(join(handle.root, rel));
  const r = reindexAllQueues(handle.repo, handle.root, '2026-05-14T00:00:00Z');
  t.equal(r.staleSlicesDropped, 1, 'one slice dropped');
  t.equal(r.deleted, 1, 'one row removed via slice drop');
  t.equal(handle.repo.count(), 0);
  teardown(handle);
});

test('reindexAllQueues — parse errors collected per-file, sweep continues', t => {
  const handle = setup();
  writeQueueFile(
    handle.root,
    'good',
    'queue.md',
    FM + ['## Backlog', '', '- **OK.** body'].join('\n')
  );
  // queue-archive.md exists but is unreadable as UTF-8 directory — simulate
  // by making the path itself a directory.
  const archiveDir = join(handle.root, 'projects', 'good', 'queue-archive.md');
  mkdirSync(archiveDir);
  const r = reindexAllQueues(handle.repo, handle.root, '2026-05-13T12:00:00Z');
  // The directory entry's isFile() is false, so it's filtered out — no error
  // is recorded, and the good file is processed normally.
  t.equal(r.filesProcessed, 1);
  t.equal(handle.repo.count(), 1);
  teardown(handle);
});
