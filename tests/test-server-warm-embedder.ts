import test from 'tape-six';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import type {Embedder} from '../src/embeddings/types.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer} from '../src/server/server.ts';

const TOKEN = 'test-token-warm';

// A model that loads on its first embed and stays loaded until released.
class SlowEmbedder implements Embedder {
  readonly dim = 384;
  readonly modelName = 'slow';
  retained = false;
  loads = 0;
  #load: Promise<void> | null = null;
  finish: () => void = () => {};

  async embed(): Promise<Float32Array> {
    if (!this.retained) {
      this.#load ??= new Promise<void>(resolve => {
        ++this.loads;
        this.finish = () => {
          this.retained = true;
          resolve();
        };
      });
      await this.#load;
    }
    return new Float32Array(this.dim);
  }
  embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map(() => this.embed()));
  }
  embedQuery(): Promise<Float32Array> {
    return this.embed();
  }
  async releaseRetained(): Promise<void> {
    this.retained = false;
    this.#load = null;
  }
}

const env = (root: string): ServerEnv => ({
  vaultDataPath: root,
  vaultIngestPath: null,
  vaultDbPath: ':memory:',
  apiToken: TOKEN,
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

test('POST /maintenance/warm-embedder starts one background load and reports a loaded model', async t => {
  const root = mkdtempSync(join(tmpdir(), 'warm-embedder-'));
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  const embedder = new SlowEmbedder();
  const handle = await startServer({
    db,
    env: env(root),
    schemaVersion: migration.current,
    embedder
  });
  const addr = handle.server.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const warm = async () => {
    const res = await fetch(`${url}/maintenance/warm-embedder`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${TOKEN}`}
    });
    return {status: res.status, body: (await res.json()) as {retained: boolean; started: boolean}};
  };
  try {
    t.deepEqual(await warm(), {status: 202, body: {retained: false, started: true}}, 'starts');
    t.deepEqual(
      await warm(),
      {status: 202, body: {retained: false, started: false}},
      'a second call while loading shares the load'
    );
    t.equal(embedder.loads, 1, 'one load');
    embedder.finish();
    await new Promise(resolve => setImmediate(resolve));
    t.deepEqual(await warm(), {status: 200, body: {retained: true, started: false}}, 'loaded');
    await embedder.releaseRetained();
    t.deepEqual(
      await warm(),
      {status: 202, body: {retained: false, started: true}},
      'after a release it starts again'
    );
    embedder.finish();
  } finally {
    await handle.close();
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});
