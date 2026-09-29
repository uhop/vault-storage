import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';
import {readTrackers, trackerLine} from '../src/server/trackers.ts';

const TEST_TOKEN = 'test-token-trackers';

const makeEnv = (port: number, vaultDataPath: string): ServerEnv => ({
  vaultDataPath,
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

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(dirname(abs), {recursive: true});
  writeFileSync(abs, content);
};

const queue = (extraFm: string[]) =>
  [
    '---',
    'title: Queue',
    'created: 2026-07-01',
    'updated: 2026-07-01',
    ...extraFm,
    '---',
    '## Active',
    '',
    '(empty)',
    ''
  ].join('\n');

interface Ctx {
  root: string;
  handle: ServerHandle;
  url: string;
}

const start = async (seedFn: (root: string) => void): Promise<Ctx> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-trackers-'));
  seedFn(root);
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
  return {root, handle, url: `http://127.0.0.1:${port}`};
};
const stop = async (ctx: Ctx): Promise<void> => {
  await ctx.handle.close();
  rmSync(ctx.root, {recursive: true, force: true});
};
const get = async (url: string, method = 'GET'): Promise<{status: number; body: any}> => {
  const res = await fetch(url, {method, headers: {Authorization: `Bearer ${TEST_TOKEN}`}});
  const text = await res.text();
  return {status: res.status, body: text ? JSON.parse(text) : null};
};

test('readTrackers: absent means the vault is primary; a declaration is validated', t => {
  const none = readTrackers('p', undefined);
  t.equal(none.declared, false);
  t.equal(none.primary.kind, 'vault');
  t.equal(trackerLine(none), 'vault');

  const ok = readTrackers('p', [
    {kind: 'linear', ref: 'ENG', role: 'primary', write: ['status']},
    {kind: 'github', ref: 'uhop/deep6'},
    {kind: 'vault', role: 'mirror'}
  ]);
  t.deepEqual(ok.problems, []);
  t.equal(ok.primary.kind, 'linear');
  t.equal(ok.primary.create, 'here', 'a primary creates by default');
  t.equal(ok.trackers[1]?.role, 'mirror', 'role defaults to mirror');
  t.equal(ok.trackers[1]?.create, 'none', 'a mirror creates nothing by default');
  t.equal(
    ok.trackers[1]?.url,
    'https://github.com/uhop/deep6/issues',
    'the GitHub link is derived'
  );
  t.equal(trackerLine(ok), 'linear ENG (primary); mirrors: github uhop/deep6, vault');

  const bad = readTrackers('p', [
    {kind: 'trello', ref: 'x'},
    {kind: 'jira'},
    {kind: 'github', ref: 'a/b', role: 'primary'},
    {kind: 'linear', ref: 'ENG', role: 'primary', url: 'https://linear.app/acme/team/ENG'}
  ]);
  t.equal(bad.trackers.length, 2, 'the unknown kind and the ref-less jira are dropped');
  t.equal(bad.primary.ref, 'a/b', 'the first primary counts');
  t.equal(bad.trackers[1]?.role, 'mirror', 'the second primary is demoted');
  t.equal(bad.trackers[1]?.url, 'https://linear.app/acme/team/ENG', 'a given url is kept');
  t.equal(bad.problems.length, 3, 'three problems named');
  t.ok(bad.problems[0]?.includes('trello'), 'naming the offender');

  const list = readTrackers('p', 'linear');
  t.equal(list.problems[0], 'trackers must be a list');
  t.equal(list.primary.kind, 'vault', 'a malformed declaration falls back to the vault');
});

test('GET /projects/{name}/trackers, the brief, and the bundle carry the declaration', async t => {
  const ctx = await start(root => {
    writeMd(
      root,
      'projects/deep6/queue.md',
      queue([
        'trackers:',
        '  - kind: linear',
        '    ref: ENG',
        '    role: primary',
        '  - kind: github',
        '    ref: uhop/deep6'
      ])
    );
    writeMd(root, 'projects/quiet/queue.md', queue([]));
  });
  try {
    const r = await get(`${ctx.url}/projects/deep6/trackers`);
    t.equal(r.status, 200);
    t.equal(r.body.declared, true);
    t.equal(r.body.primary.kind, 'linear');
    t.deepEqual(r.body.problems, []);
    t.equal(r.body.trackers.length, 2);
    t.ok(typeof r.body.as_of?.generation === 'number');

    const quiet = await get(`${ctx.url}/projects/quiet/trackers`);
    t.equal(quiet.body.declared, false, 'no declaration');
    t.equal(quiet.body.primary.kind, 'vault');

    const missing = await get(`${ctx.url}/projects/nope/trackers`);
    t.equal(missing.body.declared, false, 'no queue at all reads as the default too');

    t.equal(
      (await get(`${ctx.url}/projects/Bad_Name/trackers`)).status,
      400,
      'a bad name is a 400'
    );
    t.equal(
      (await get(`${ctx.url}/projects/deep6/trackers?x=1`)).status,
      400,
      'an unknown parameter is a 400'
    );

    const brief = await get(`${ctx.url}/system/resume-brief?project=deep6`);
    t.equal(brief.body.project.trackers.line, 'linear ENG (primary); mirrors: github uhop/deep6');
    t.equal(brief.body.project.trackers.primary.kind, 'linear');

    const bundle = await get(`${ctx.url}/system/resume-bundle?project=deep6&logs=0`, 'POST');
    t.equal(bundle.body.project.trackers.primary.ref, 'ENG', 'the bundle carries the whole view');
    t.equal(bundle.body.project.trackers.trackers.length, 2);
  } finally {
    await stop(ctx);
  }
});
