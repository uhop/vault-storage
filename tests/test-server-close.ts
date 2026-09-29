import test from 'tape-six';
import {Agent, request, type ClientRequest} from 'node:http';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-close';

const makeEnv = (): ServerEnv => ({
  vaultDataPath: '/tmp/vault-storage-close-test-data',
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

const start = async (): Promise<{handle: ServerHandle; port: number; done: () => void}> => {
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  const handle = await startServer({
    db,
    env: makeEnv(),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {handle, port, done: () => db.close()};
};

// A write whose headers and first bytes have arrived: in flight until the body ends.
const openWrite = (port: number, agent: Agent): ClientRequest => {
  const req = request({
    host: '127.0.0.1',
    port,
    agent,
    method: 'POST',
    path: '/vault/edit',
    headers: {Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json'}
  });
  req.write('{"path": "topics/absent.md", ');
  return req;
};

const answer = (req: ClientRequest): Promise<number> =>
  new Promise((resolve, reject) => {
    req.once('response', res => {
      res.resume();
      res.once('end', () => resolve(res.statusCode ?? 0));
    });
    req.once('error', reject);
  });

test('server close: a request in flight answers, and its connection closes once it idles', async t => {
  const {handle, port, done} = await start();
  const agent = new Agent({keepAlive: true});
  try {
    const arrived = new Promise<void>(resolve => handle.server.once('request', () => resolve()));
    const req = openWrite(port, agent);
    const answered = answer(req);
    await arrived;
    const started = Date.now();
    const closed = handle.close();
    req.end('"op": "append", "text": "x"}');
    t.equal(await answered, 404, 'the handler ran and answered after close() was called');
    await closed;
    t.ok(Date.now() - started < 2_000, 'no wait for the keep-alive timeout or the grace');
    await t.rejects(
      fetch(`http://127.0.0.1:${port}/system/status`),
      'the next connection is refused'
    );
  } finally {
    agent.destroy();
    done();
  }
});

test('server close: a request that never ends is cut at the grace', async t => {
  const {handle, port, done} = await start();
  const agent = new Agent({keepAlive: true});
  try {
    const arrived = new Promise<void>(resolve => handle.server.once('request', () => resolve()));
    const req = openWrite(port, agent);
    const answered = answer(req);
    await arrived;
    const started = Date.now();
    await handle.close(100);
    const took = Date.now() - started;
    t.ok(took >= 100 && took < 2_000, `closed at the grace (${took} ms)`);
    await t.rejects(answered, 'the client sees the dropped connection');
  } finally {
    agent.destroy();
    done();
  }
});
