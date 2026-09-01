import test from 'tape-six';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-expire-logs';

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

const ageDays = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const startTestServer = async (): Promise<ServerCtx> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-expire-logs-test-'));
  writeMd(
    root,
    'logs/old.md',
    `---\ntitle: Old\nupdated: ${ageDays(200)}\ncreated: ${ageDays(200)}\n---\nbody\n`
  );
  writeMd(
    root,
    'logs/recent.md',
    `---\ntitle: Recent\nupdated: ${ageDays(2)}\ncreated: ${ageDays(2)}\n---\nbody\n`
  );
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, root);
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

const post = (ctx: ServerCtx, query: string): Promise<Response> =>
  fetch(`${ctx.url}/maintenance/expire-logs${query}`, {
    method: 'POST',
    headers: {Authorization: `Bearer ${TEST_TOKEN}`}
  });

interface ExpireBody {
  scanned: number;
  qualifying: number;
  deleted: number;
  logs: Array<{file_path: string; age_days: number}>;
  dryRun: boolean;
  days: number;
  errors: unknown[];
}

test('POST /maintenance/expire-logs deletes past-window logs', async t => {
  const ctx = await startTestServer();
  try {
    const res = await post(ctx, '');
    t.equal(res.status, 200, '200 ok');
    const body = (await res.json()) as ExpireBody;
    t.equal(body.days, 90, 'defaults to the policy window');
    t.equal(body.scanned, 2);
    t.equal(body.qualifying, 1);
    t.equal(body.deleted, 1);
    t.deepEqual(
      body.logs.map(l => l.file_path),
      ['logs/old.md']
    );
    t.notOk(existsSync(join(ctx.root, 'logs/old.md')), 'removed from disk');
    t.ok(existsSync(join(ctx.root, 'logs/recent.md')), 'fresh log kept');
  } finally {
    await teardown(ctx);
  }
});

test('POST /maintenance/expire-logs?dry_run=1 previews without deleting', async t => {
  const ctx = await startTestServer();
  try {
    const body = (await (await post(ctx, '?dry_run=1')).json()) as ExpireBody;
    t.ok(body.dryRun);
    t.equal(body.qualifying, 1);
    t.equal(body.deleted, 0);
    t.ok(existsSync(join(ctx.root, 'logs/old.md')), 'still on disk');
  } finally {
    await teardown(ctx);
  }
});

test('POST /maintenance/expire-logs honors days', async t => {
  const ctx = await startTestServer();
  try {
    const body = (await (await post(ctx, '?days=1&dry_run=1')).json()) as ExpireBody;
    t.equal(body.days, 1);
    t.equal(body.qualifying, 2, 'both logs are past a one-day window');
  } finally {
    await teardown(ctx);
  }
});

test('POST /maintenance/expire-logs rejects bad params', async t => {
  const ctx = await startTestServer();
  try {
    t.equal((await post(ctx, '?days=0')).status, 400, 'days must be positive');
    t.equal((await post(ctx, '?days=abc')).status, 400, 'days must be an integer');
    t.equal((await post(ctx, '?dry_run=maybe')).status, 400, 'dry_run is a boolean');
    t.equal((await post(ctx, '?limit=0')).status, 400, 'limit must be positive');
    t.equal((await post(ctx, '?nope=1')).status, 400, 'unknown params rejected');
    t.ok(existsSync(join(ctx.root, 'logs/old.md')), 'no rejected call deleted anything');
  } finally {
    await teardown(ctx);
  }
});

test('POST /maintenance/expire-logs requires bearer auth', async t => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.url}/maintenance/expire-logs`, {method: 'POST'});
    t.equal(res.status, 401, '401 unauthorized');
    t.ok(existsSync(join(ctx.root, 'logs/old.md')), 'unauthenticated call deleted nothing');
  } finally {
    await teardown(ctx);
  }
});
