import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-unknown-params';

const makeEnv = (port: number, dataPath: string, uiPath: string): ServerEnv => ({
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
  commitIntervalMs: 60000,
  commitIntervalMaxMs: 0,
  workHoursStart: null,
  workHoursEnd: null,
  gitAuthorName: 'vault-storage',
  gitAuthorEmail: 'vault-storage@localhost',
  uiStaticPath: uiPath,
  embedAnomalyLogPath: '',
  memoryReportIntervalMs: 0
});

// Every route that takes a query string, with a method that reaches its
// handler. Dummy path params are deliberate: the guard runs before the id
// lookup and before the body is read, so a bogus id must still surface the
// parameter error rather than a 404 — that ordering is what these pin.
const ROUTES: Array<[string, string]> = [
  ['GET', '/system/status'],
  ['GET', '/system/lint'],
  ['POST', '/system/resume-bundle'],
  ['GET', '/system/resume-brief'],
  ['POST', '/context-pack'],
  ['GET', '/sections'],
  ['GET', '/sections/nope/neighborhood'],
  ['GET', '/sections/nope/similar'],
  ['GET', '/sections/nope/backlinks'],
  ['GET', '/sections/nope/meta'],
  ['GET', '/sections/nope/fm'],
  ['PATCH', '/sections/nope/fm'],
  ['GET', '/sections/nope/tags'],
  ['POST', '/sections/nope/tags'],
  ['DELETE', '/sections/nope/tags/sometag'],
  ['GET', '/sections/nope'],
  ['PUT', '/sections/nope'],
  ['GET', '/tags'],
  ['GET', '/tags/sometag/records'],
  ['GET', '/tags/sometag'],
  ['POST', '/tags/taxonomy'],
  ['POST', '/tags/aliases'],
  ['GET', '/suggestions'],
  ['POST', '/suggestions'],
  ['GET', '/suggestions/summary'],
  ['POST', '/suggestions/claim'],
  ['POST', '/suggestions/resolve-batch'],
  ['GET', '/suggestions/nope'],
  ['POST', '/suggestions/nope/accept'],
  ['POST', '/suggestions/nope/reject'],
  ['POST', '/suggestions/nope/reopen'],
  ['GET', '/vault/'],
  ['GET', '/vault/topics/nope.md'],
  ['PUT', '/vault/topics/nope.md'],
  ['DELETE', '/vault/topics/nope.md'],
  ['POST', '/vault/edit'],
  ['POST', '/vault/move'],
  ['POST', '/vault/supersede'],
  ['POST', '/vault/propose'],
  ['POST', '/search/simple/'],
  ['POST', '/search/simple'],
  ['GET', '/resolve'],
  ['POST', '/commit'],
  ['POST', '/maintenance/find-duplicates'],
  ['POST', '/maintenance/find-compaction-candidates'],
  ['POST', '/maintenance/find-retention-candidates'],
  ['POST', '/maintenance/find-upgrade-signals'],
  ['POST', '/maintenance/cleanup-lint'],
  ['POST', '/maintenance/cleanup-tag-aliases'],
  ['POST', '/maintenance/embed-pending'],
  ['POST', '/maintenance/release-embedder'],
  ['POST', '/maintenance/run-all'],
  ['GET', '/maintenance/raw-inbox'],
  ['GET', '/maintenance/folder-listing'],
  ['POST', '/maintenance/snapshot'],
  ['GET', '/maintenance/snapshot-download'],
  ['GET', '/maintenance/snapshot-list'],
  ['DELETE', '/maintenance/snapshot'],
  ['POST', '/maintenance/incremental-reindex'],
  ['POST', '/maintenance/reindex-queues'],
  ['GET', '/queue/top'],
  ['GET', '/queue/ready'],
  ['GET', '/queue/blocked'],
  ['GET', '/queue/by-section/Active'],
  ['GET', '/queue/by-priority/1'],
  ['GET', '/queue/projects/demo/archive'],
  ['GET', '/queue/projects/demo'],
  ['GET', '/leases'],
  ['GET', '/leases/events'],
  ['POST', '/leases/claim'],
  ['POST', '/leases/renew'],
  ['POST', '/leases/release'],
  ['POST', '/leases/transfer']
];

const withServer = async (fn: (url: string) => Promise<void>): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-unknown-params-'));
  const ui = join(root, '.ui');
  mkdirSync(ui, {recursive: true});
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>ui</title>', 'utf8');
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  const handle = await startServer({
    db,
    env: makeEnv(0, root, ui),
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
    rmSync(root, {recursive: true, force: true});
  }
};

test('every query-taking route rejects an unknown parameter', async t => {
  await withServer(async url => {
    for (const [method, path] of ROUTES) {
      const res = await fetch(`${url}${path}?zzz=1`, {
        method,
        headers: {Authorization: `Bearer ${TEST_TOKEN}`}
      });
      const text = await res.text();
      t.equal(res.status, 400, `${method} ${path} → 400`);
      t.ok(text.includes('zzz'), `${method} ${path} names the offender`);
    }
  });
});

test('the static UI surface is deliberately exempt — cache-busting must not 400', async t => {
  await withServer(async url => {
    // Browsers and bundlers append `?v=<hash>` to asset URLs; rejecting those
    // would break loading. staticHandler is the one route left unguarded.
    const res = await fetch(`${url}/ui/index.html?v=abc123`, {
      headers: {Authorization: `Bearer ${TEST_TOKEN}`}
    });
    t.equal(res.status, 200, 'asset served despite the query string');
  });
});
