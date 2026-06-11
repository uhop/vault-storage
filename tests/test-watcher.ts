import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {RecordsRepository} from '../src/records/repository.ts';
import {startWatcher} from '../src/server/watcher.ts';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'vault-watcher-test-'));
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  const records = new RecordsRepository(db);
  const embedder = new FakeEmbedder();
  return {root, db, records, embedder};
};

const teardown = (fx: ReturnType<typeof setup>): void => {
  fx.db.close();
  rmSync(fx.root, {recursive: true, force: true});
};

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

test('watcher: new file → record inserted via flush', async t => {
  const fx = setup();
  // Quick debounce so the test isn't slow; flush() bypasses the timer anyway.
  const watcher = startWatcher({
    db: fx.db,
    vaultDataPath: fx.root,
    embedder: fx.embedder,
    debounceMs: 60_000,
    log: () => {}
  });

  try {
    writeMd(fx.root, 'topics/new.md', '---\ntitle: New\n---\nbody\n');
    await sleep(150); // let fs.watch fire
    const summary = await watcher.flush();
    t.equal(summary.imported, 1, 'one file imported');
    const rec = fx.records.getByPath('topics/new.md');
    t.ok(rec, 'record exists');
    t.equal(rec?.title, 'New');
  } finally {
    watcher.close();
    teardown(fx);
  }
});

test('watcher: file edit → existing record updated', async t => {
  const fx = setup();
  // Pre-create directory so the recursive watcher subtree includes it.
  mkdirSync(join(fx.root, 'topics'), {recursive: true});

  const watcher = startWatcher({
    db: fx.db,
    vaultDataPath: fx.root,
    embedder: fx.embedder,
    debounceMs: 60_000,
    log: () => {}
  });

  try {
    writeMd(fx.root, 'topics/x.md', '---\ntitle: X1\n---\nv1\n');
    await sleep(150);
    await watcher.flush();
    const before = fx.records.getByPath('topics/x.md');
    t.ok(before, 'inserted');

    writeMd(fx.root, 'topics/x.md', '---\ntitle: X2\n---\nv2 updated\n');
    await sleep(150);
    await watcher.flush();
    const after = fx.records.getByPath('topics/x.md');
    t.equal(after?.title, 'X2', 'title updated');
    t.notEqual(after?.contentHash, before?.contentHash, 'content_hash changed');
    t.equal(after?.recordId, before?.recordId, 'record_id preserved across edit');
  } finally {
    watcher.close();
    teardown(fx);
  }
});

test('watcher: file delete → record removed', async t => {
  const fx = setup();
  // Pre-create the directory so fs.watch's recursive subtree includes it.
  mkdirSync(join(fx.root, 'topics'), {recursive: true});

  const watcher = startWatcher({
    db: fx.db,
    vaultDataPath: fx.root,
    embedder: fx.embedder,
    debounceMs: 60_000,
    log: () => {}
  });

  try {
    writeMd(fx.root, 'topics/doomed.md', '---\ntitle: Doomed\n---\nbye\n');
    await sleep(150);
    await watcher.flush();
    t.ok(fx.records.getByPath('topics/doomed.md'), 'present after first flush');

    unlinkSync(join(fx.root, 'topics/doomed.md'));
    await sleep(150);
    const summary = await watcher.flush();
    t.equal(summary.deleted, 1, 'one file deleted');
    t.equal(fx.records.getByPath('topics/doomed.md'), null, 'record gone');
  } finally {
    watcher.close();
    teardown(fx);
  }
});

test('watcher: ignores .vault-storage and non-md files', async t => {
  const fx = setup();
  const watcher = startWatcher({
    db: fx.db,
    vaultDataPath: fx.root,
    embedder: fx.embedder,
    debounceMs: 60_000,
    log: () => {}
  });

  try {
    writeMd(fx.root, '.vault-storage/internal.md', '---\ntitle: Internal\n---\nx\n');
    writeMd(fx.root, 'topics/note.txt', 'not markdown');
    writeMd(fx.root, 'topics/real.md', '---\ntitle: Real\n---\nx\n');
    await sleep(150);
    const summary = await watcher.flush();
    t.equal(summary.imported, 1, 'only the .md outside .vault-storage');
    t.ok(fx.records.getByPath('topics/real.md'), 'real imported');
    t.equal(fx.records.getByPath('.vault-storage/internal.md'), null, 'ignored');
  } finally {
    watcher.close();
    teardown(fx);
  }
});

test('watcher: content-only edit takes the scoped edge rebuild', async t => {
  const fx = setup();
  const watcher = startWatcher({
    db: fx.db,
    vaultDataPath: fx.root,
    embedder: fx.embedder,
    debounceMs: 60_000,
    log: () => {}
  });

  try {
    writeMd(fx.root, 'topics/alpha.md', '---\ntitle: Alpha\n---\nCites [[topics/beta]] and [[topics/gamma]].\n');
    writeMd(fx.root, 'topics/beta.md', '---\ntitle: Beta\n---\nCites [[topics/gamma]].\n');
    writeMd(fx.root, 'topics/gamma.md', '---\ntitle: Gamma\n---\nNo links.\n');
    await sleep(150);
    const first = await watcher.flush();
    t.equal(first.edgesCreated, 3, 'full rebuild on the creating batch: 3 edges');

    // Content-only edit: alpha drops its gamma link. A full rebuild would
    // re-upsert all remaining edges (2); the scoped path touches only
    // alpha's (1). The count doubles as a probe that scoping engaged.
    writeMd(fx.root, 'topics/alpha.md', '---\ntitle: Alpha\n---\nCites [[topics/beta]].\n');
    await sleep(150);
    const second = await watcher.flush();
    t.equal(second.imported, 1, 'one file imported');
    t.equal(second.edgesCreated, 1, 'scoped rebuild: only alpha re-upserted');

    const records = new RecordsRepository(fx.db);
    const alpha = records.getByPath('topics/alpha.md')!;
    const gamma = records.getByPath('topics/gamma.md')!;
    const {EdgesRepository} = await import('../src/records/edges.ts');
    const edges = new EdgesRepository(fx.db);
    t.notOk(
      edges.listOutbound(alpha.recordId).some(e => e.toId === gamma.recordId),
      'stale alpha→gamma edge GCd by the scoped pass'
    );
    t.equal(edges.listOutbound(alpha.recordId).length, 1, 'alpha keeps its beta edge');
  } finally {
    watcher.close();
    teardown(fx);
  }
});
