import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-abcdef';

const makeEnv = (port: number): ServerEnv => ({
  vaultDataPath: '/tmp/vault-storage-test-data',
  vaultIngestPath: null,
  vaultDbPath: ':memory:',
  apiToken: TEST_TOKEN,
  host: '127.0.0.1',
  port,
  autoReindex: false,
  autoWatch: false,
  watchDebounceMs: 1500,
  embedder: 'fake',
  autoCommit: false,
  autoPush: false,
  commitIntervalMs: 60000
});

const fetchJson = async (
  url: string,
  init: RequestInit = {}
): Promise<{status: number; body: unknown}> => {
  const res = await fetch(url, init);
  const text = await res.text();
  const body = text.length === 0 ? null : JSON.parse(text);
  return {status: res.status, body};
};

const withServer = async (fn: (url: string) => Promise<void>): Promise<void> => {
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  // port 0 → OS picks a free port
  const handle = await startServer({
    db,
    env: makeEnv(0),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const url = `http://127.0.0.1:${port}`;
  try {
    await fn(url);
  } finally {
    await handle.close();
    db.close();
  }
};

test('GET /system/status returns 401 without bearer token', async t => {
  await withServer(async url => {
    const {status, body} = await fetchJson(`${url}/system/status`);
    t.equal(status, 401, '401 unauthorized');
    t.equal((body as {code: string}).code, 'unauthorized', 'code=unauthorized');
  });
});

test('GET /system/status returns 401 with wrong bearer token', async t => {
  await withServer(async url => {
    const {status} = await fetchJson(`${url}/system/status`, {
      headers: {Authorization: 'Bearer not-the-right-token-xx'}
    });
    t.equal(status, 401, '401 on wrong token');
  });
});

test('GET /system/status with valid token returns indexer status', async t => {
  await withServer(async url => {
    const {status, body} = await fetchJson(`${url}/system/status`, {
      headers: {Authorization: `Bearer ${TEST_TOKEN}`}
    });
    t.equal(status, 200, '200 ok');
    const payload = body as Record<string, unknown>;
    t.equal(payload['ok'], true, 'ok=true');
    t.equal(payload['schema_version'], 4, 'schema_version=4 (records + add-title + sync-baseline + doc-vecs)');
    t.equal(payload['records'], 0, 'records=0 on empty DB');
    t.equal(payload['edges'], 0, 'edges=0 on empty DB');
    t.equal(payload['pending_suggestions'], 0, 'pending_suggestions=0 on empty DB');
    t.equal(typeof payload['sqlite_vec_version'], 'string', 'sqlite_vec_version is a string');
  });
});

test('unknown route returns 404', async t => {
  await withServer(async url => {
    const {status, body} = await fetchJson(`${url}/does/not/exist`, {
      headers: {Authorization: `Bearer ${TEST_TOKEN}`}
    });
    t.equal(status, 404, '404 not found');
    t.equal((body as {code: string}).code, 'not_found', 'code=not_found');
  });
});

test('wrong method on known route returns 405', async t => {
  await withServer(async url => {
    const {status, body} = await fetchJson(`${url}/system/status`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${TEST_TOKEN}`}
    });
    t.equal(status, 405, '405 method not allowed');
    t.equal((body as {code: string}).code, 'method_not_allowed', 'code=method_not_allowed');
  });
});
