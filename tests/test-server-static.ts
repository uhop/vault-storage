import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-static';

const makeEnv = (uiStaticPath: string): ServerEnv => ({
  vaultDataPath: '/tmp/vault-storage-test-data',
  vaultIngestPath: null,
  vaultDbPath: ':memory:',
  apiToken: TEST_TOKEN,
  host: '127.0.0.1',
  port: 0,
  autoReindex: false,
  autoWatch: false,
  watchDebounceMs: 1500,
  embedder: 'fake',
  autoCommit: false,
  autoPush: false,
  commitIntervalMs: 60000,
  gitAuthorName: 'vault-storage',
  gitAuthorEmail: 'vault-storage@localhost',
  uiStaticPath
});

const withServer = async (
  uiStaticPath: string,
  fn: (url: string) => Promise<void>
): Promise<void> => {
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  const handle = await startServer({
    db,
    env: makeEnv(uiStaticPath),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await handle.close();
    db.close();
  }
};

const withStaticDir = async (
  fn: (dir: string) => Promise<void>
): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-static-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
};

test('GET /ui/ serves index.html without bearer auth', async t => {
  await withStaticDir(async dir => {
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>vault</title>');
    await withServer(dir, async url => {
      const res = await fetch(`${url}/ui/`);
      t.equal(res.status, 200, '200 OK');
      t.equal(res.headers.get('content-type'), 'text/html; charset=utf-8', 'html mime');
      const body = await res.text();
      t.ok(body.includes('<title>vault</title>'), 'served index body');
    });
  });
});

test('GET /ui (no slash) also serves index.html', async t => {
  await withStaticDir(async dir => {
    writeFileSync(join(dir, 'index.html'), 'root index');
    await withServer(dir, async url => {
      const res = await fetch(`${url}/ui`);
      t.equal(res.status, 200, '200 OK');
      t.equal(await res.text(), 'root index', 'body');
    });
  });
});

test('GET /ui/<file> serves named file', async t => {
  await withStaticDir(async dir => {
    writeFileSync(join(dir, 'index.html'), 'root');
    writeFileSync(join(dir, 'app.js'), 'export const x = 1;');
    await withServer(dir, async url => {
      const res = await fetch(`${url}/ui/app.js`);
      t.equal(res.status, 200, '200 OK');
      t.equal(res.headers.get('content-type'), 'application/javascript; charset=utf-8', 'js mime');
      t.equal(await res.text(), 'export const x = 1;', 'body');
    });
  });
});

test('GET /ui/<missing> returns 404', async t => {
  await withStaticDir(async dir => {
    writeFileSync(join(dir, 'index.html'), 'root');
    await withServer(dir, async url => {
      const res = await fetch(`${url}/ui/no-such.html`);
      t.equal(res.status, 404, '404');
    });
  });
});

test('path traversal rejected', async t => {
  await withStaticDir(async dir => {
    writeFileSync(join(dir, 'index.html'), 'root');
    await withServer(dir, async url => {
      const res = await fetch(`${url}/ui/..%2F..%2Fetc%2Fpasswd`);
      t.ok(res.status === 400 || res.status === 404, 'rejected');
    });
  });
});

test('If-None-Match returns 304 with no body', async t => {
  await withStaticDir(async dir => {
    writeFileSync(join(dir, 'index.html'), 'cacheable');
    await withServer(dir, async url => {
      const first = await fetch(`${url}/ui/`);
      const etag = first.headers.get('etag');
      t.ok(etag && etag.length > 0, 'first response has etag');
      const second = await fetch(`${url}/ui/`, {headers: {'If-None-Match': etag!}});
      t.equal(second.status, 304, '304 Not Modified');
      t.equal(await second.text(), '', 'empty body on 304');
    });
  });
});

test('GET /system/status still requires bearer (UI carve-out is /ui/ only)', async t => {
  await withStaticDir(async dir => {
    writeFileSync(join(dir, 'index.html'), 'root');
    await withServer(dir, async url => {
      const res = await fetch(`${url}/system/status`);
      t.equal(res.status, 401, '401 without token');
    });
  });
});

test('uiStaticPath empty string disables /ui/ surface', async t => {
  await withServer('', async url => {
    const res = await fetch(`${url}/ui/`);
    t.equal(res.status, 404, 'no route registered when ui disabled');
  });
});
