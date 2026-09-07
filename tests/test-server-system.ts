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
    t.equal(
      payload['schema_version'],
      21,
      'schema_version=21 (all migrations through the handoff touches and verifications)'
    );
    t.equal(payload['records'], 0, 'records=0 on empty DB');
    t.equal(payload['edges'], 0, 'edges=0 on empty DB');
    t.equal(payload['pending_suggestions'], 0, 'pending_suggestions=0 on empty DB');
    t.equal(typeof payload['sqlite_vec_version'], 'string', 'sqlite_vec_version is a string');
    const memory = payload['memory'] as Record<string, unknown>;
    t.equal(typeof memory, 'object', 'memory is an object');
    for (const key of ['rss', 'heap_used', 'heap_total', 'external', 'array_buffers']) {
      t.equal(typeof memory[key], 'number', `memory.${key} is a number`);
      t.ok((memory[key] as number) > 0, `memory.${key} > 0`);
    }
  });
});

test('GET /system/health answers from memory with the watchdog and outcome blocks', async t => {
  await withServer(async url => {
    const {status, body} = await fetchJson(`${url}/system/health`, {
      headers: {Authorization: `Bearer ${TEST_TOKEN}`}
    });
    t.equal(status, 200, '200 ok');
    const h = body as Record<string, any>;
    t.equal(h['ok'], true, 'ok');
    t.equal(h['stalled'], false, 'not stalled');
    t.equal(typeof h['uptime_s'], 'number');
    t.ok(!Number.isNaN(Date.parse(h['started_at'])), 'started_at is an instant');
    t.equal(h['loop'].watchdog_interval_ms, 5000, 'default watchdog');
    t.equal(h['loop'].lag_ms, 0);
    t.deepEqual(h['git_sync'], {
      last_at: null,
      last_ok: null,
      last_error: null,
      runs: 0,
      failures: 0,
      consecutive_timeouts: 0,
      timeouts: 0
    });
    t.equal(h['reindex'].runs, 0);
    t.deepEqual(h['watcher'], {last_event_at: null, events: 0});
    const bogus = await fetchJson(`${url}/system/health?x=1`, {
      headers: {Authorization: `Bearer ${TEST_TOKEN}`}
    });
    t.equal(bogus.status, 400, 'unknown parameters rejected');
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
