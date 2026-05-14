import test from 'tape-six';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-snapshot-list';

const makeEnv = (port: number, dataPath: string): ServerEnv => ({
  vaultDataPath: dataPath,
  vaultIngestPath: null,
  vaultDbPath: ':memory:',
  apiToken: TEST_TOKEN,
  host: '127.0.0.1',
  port,
  autoReindex: false,
  autoWatch: false,
  watchDebounceMs: 1500,
  embedder: 'fake',
  embedderRetentionMs: 1_800_000,
  embedderMaxBatch: 8,
  autoCommit: false,
  autoPush: false,
  commitIntervalMs: 60_000,
  commitIntervalMaxMs: 0,
  workHoursStart: null,
  workHoursEnd: null,
  gitAuthorName: 'vault-storage',
  gitAuthorEmail: 'vault-storage@localhost',
  uiStaticPath: '',
  embedAnomalyLogPath: '',
  memoryReportIntervalMs: 0
});

interface ServerCtx {
  db: DatabaseSync;
  handle: ServerHandle;
  url: string;
  root: string;
}

const startTestServer = async (): Promise<ServerCtx> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-snap-test-'));
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  const handle = await startServer({
    db,
    env: makeEnv(0, root),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {db, handle, url: `http://127.0.0.1:${port}`, root};
};

const teardown = async ({db, handle, root}: ServerCtx): Promise<void> => {
  await handle.close();
  db.close();
  rmSync(root, {recursive: true, force: true});
};

const auth = {Authorization: `Bearer ${TEST_TOKEN}`};

test('GET /maintenance/snapshot-list returns empty list when .snapshots/ is missing', async t => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.url}/maintenance/snapshot-list`, {headers: auth});
    t.equal(res.status, 200, '200 ok');
    const body = (await res.json()) as {snapshots: unknown[]; totalBytes: number};
    t.deepEqual(body.snapshots, [], 'empty list');
    t.equal(body.totalBytes, 0, 'totalBytes 0');
  } finally {
    await teardown(ctx);
  }
});

test('GET /maintenance/snapshot-list returns files sorted newest-first with bytes + mtime', async t => {
  const ctx = await startTestServer();
  try {
    const dir = join(ctx.root, '.snapshots');
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, 'old.sqlite.gz'), Buffer.alloc(100, 1));
    // Bump mtime distinctly so the sort is deterministic.
    await new Promise(r => setTimeout(r, 20));
    writeFileSync(join(dir, 'new.sqlite.gz'), Buffer.alloc(250, 2));
    // Subdirs must be skipped.
    mkdirSync(join(dir, 'archive'));

    const res = await fetch(`${ctx.url}/maintenance/snapshot-list`, {headers: auth});
    t.equal(res.status, 200, '200 ok');
    const body = (await res.json()) as {
      snapshots: {name: string; bytes: number; mtime: string}[];
      totalBytes: number;
    };
    t.equal(body.snapshots.length, 2, 'two snapshot files');
    t.equal(body.snapshots[0]?.name, 'new.sqlite.gz', 'newest first');
    t.equal(body.snapshots[0]?.bytes, 250, 'newest bytes match');
    t.equal(body.snapshots[1]?.name, 'old.sqlite.gz', 'older second');
    t.equal(body.snapshots[1]?.bytes, 100, 'older bytes match');
    t.equal(body.totalBytes, 350, 'totalBytes sums file sizes');
    t.ok(body.snapshots[0]?.mtime && body.snapshots[1]?.mtime, 'mtime ISO strings present');
  } finally {
    await teardown(ctx);
  }
});

test('DELETE /maintenance/snapshot?name=… removes the file and returns 204', async t => {
  const ctx = await startTestServer();
  try {
    const dir = join(ctx.root, '.snapshots');
    mkdirSync(dir, {recursive: true});
    const target = join(dir, 'old.sqlite.gz');
    writeFileSync(target, Buffer.alloc(50));
    t.ok(existsSync(target), 'file exists before delete');

    const res = await fetch(`${ctx.url}/maintenance/snapshot?name=old.sqlite.gz`, {
      method: 'DELETE',
      headers: auth
    });
    t.equal(res.status, 204, '204 no content');
    t.notOk(existsSync(target), 'file removed from disk');
  } finally {
    await teardown(ctx);
  }
});

test('DELETE /maintenance/snapshot rejects names with path separators', async t => {
  const ctx = await startTestServer();
  try {
    for (const name of ['', '../etc/passwd', 'sub/dir.gz', 'win\\path.gz']) {
      const url = `${ctx.url}/maintenance/snapshot?name=${encodeURIComponent(name)}`;
      const res = await fetch(url, {method: 'DELETE', headers: auth});
      t.equal(res.status, 400, `400 on bad name "${name}"`);
    }
  } finally {
    await teardown(ctx);
  }
});

test('DELETE /maintenance/snapshot returns 404 when the file is missing', async t => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.url}/maintenance/snapshot?name=missing.sqlite.gz`, {
      method: 'DELETE',
      headers: auth
    });
    t.equal(res.status, 404, '404 not found');
  } finally {
    await teardown(ctx);
  }
});

test('DELETE /maintenance/snapshot returns 404 when the target is a directory', async t => {
  const ctx = await startTestServer();
  try {
    mkdirSync(join(ctx.root, '.snapshots', 'is-a-dir'), {recursive: true});
    const res = await fetch(`${ctx.url}/maintenance/snapshot?name=is-a-dir`, {
      method: 'DELETE',
      headers: auth
    });
    t.equal(res.status, 404, '404 not a file');
  } finally {
    await teardown(ctx);
  }
});

test('snapshot-list and snapshot delete both require bearer auth', async t => {
  const ctx = await startTestServer();
  try {
    const list = await fetch(`${ctx.url}/maintenance/snapshot-list`);
    t.equal(list.status, 401, 'list 401 without auth');
    const del = await fetch(`${ctx.url}/maintenance/snapshot?name=foo.gz`, {method: 'DELETE'});
    t.equal(del.status, 401, 'delete 401 without auth');
  } finally {
    await teardown(ctx);
  }
});
