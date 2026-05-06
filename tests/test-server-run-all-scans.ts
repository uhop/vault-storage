import test from 'tape-six';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-run-all';

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
  autoCommit: false,
  autoPush: false,
  commitIntervalMs: 60_000,
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
  const root = mkdtempSync(join(tmpdir(), 'vault-run-all-test-'));
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

test('POST /maintenance/run-all returns a summary for each scan', async t => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.url}/maintenance/run-all`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${TEST_TOKEN}`}
    });
    t.equal(res.status, 200, '200 ok');
    const body = (await res.json()) as {
      duplicates: unknown;
      compaction: unknown;
      retention: unknown;
      upgrade: unknown;
      durationMs: number;
    };
    t.ok(body.duplicates && typeof body.duplicates === 'object', 'duplicates summary present');
    t.ok(body.compaction && typeof body.compaction === 'object', 'compaction summary present');
    t.ok(body.retention && typeof body.retention === 'object', 'retention summary present');
    t.ok(body.upgrade && typeof body.upgrade === 'object', 'upgrade summary present');
    t.ok(typeof body.durationMs === 'number' && body.durationMs >= 0, 'durationMs is a number');
  } finally {
    await teardown(ctx);
  }
});

test('POST /maintenance/run-all requires bearer auth', async t => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.url}/maintenance/run-all`, {method: 'POST'});
    t.equal(res.status, 401, '401 unauthorized');
  } finally {
    await teardown(ctx);
  }
});
