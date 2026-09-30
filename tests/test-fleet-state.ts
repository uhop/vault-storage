import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {DIGEST_PATH, FleetStateRepository, parseRuns, parseSection} from '../src/fleet/state.ts';
import {importVault} from '../src/importer/import.ts';
import {RecordsRepository} from '../src/records/repository.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {parseSince} from '../src/server/handlers/fleet.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-fleet';

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

const fm = (title: string): string =>
  [
    '---',
    `title: ${title}`,
    'type: state',
    'created: 2026-09-01',
    'updated: 2026-09-01',
    '---'
  ].join('\n');

const github = (repo: string, at: string, stars: number): string =>
  JSON.stringify({repo, collected_at: at, metadata: {stars}, open_items: []}, null, 2);
const packages = (repo: string, at: string): string =>
  JSON.stringify({collected_at: at, packages: [{name: repo.split('/')[1], repo, published: true}]});

const stateDoc = (repo: string, at: string, stars = 1, withPackages = true): string =>
  [
    fm(`${repo} — State`),
    'Drift baseline prose above the blocks.',
    '',
    '## GitHub',
    '',
    '```json',
    github(repo, at, stars),
    '```',
    '',
    ...(withPackages ? ['## Packages', '', '```json', packages(repo, at), '```', ''] : [])
  ].join('\n');

const run = (
  at: string,
  repos: Array<{repo: string; project: string; events: number}>
): object => ({
  collected_at: at,
  mode: 'fleet',
  gh_user: 'uhop',
  totals: {repos: repos.length, events: repos.reduce((n, r) => n + r.events, 0)},
  repos: repos.map(r => ({
    repo: r.repo,
    project: r.project,
    first_run: false,
    events: Array.from({length: r.events}, (_, i) => ({kind: 'issue.opened', number: i + 1}))
  }))
});

const digestDoc = (runs: object[]): string =>
  [
    fm('Fleet status — GitHub digest'),
    'One section per run, newest first.',
    '',
    ...runs.flatMap(r => [
      `## ${(r as {collected_at: string}).collected_at}`,
      '',
      'Mode: fleet.',
      '',
      '```json',
      JSON.stringify(r, null, 2),
      '```',
      ''
    ])
  ].join('\n');

test('parseSection and parseRuns read the fenced blocks the CLI writes', t => {
  const body = stateDoc('uhop/a', '2026-09-30T01:00:00Z', 7).split('\n---\n')[1]!;
  t.equal((parseSection(body, '## GitHub') as {repo: string}).repo, 'uhop/a');
  t.equal((parseSection(body, '## Packages') as {packages: unknown[]}).packages.length, 1);
  t.equal(parseSection(body, '## Nope'), null, 'an absent heading is null');
  t.equal(
    parseSection('## GitHub\n\n```json\n{bad\n```\n', '## GitHub'),
    null,
    'malformed JSON is null'
  );
  t.equal(
    (parseSection('## GitHub\n\n```json\n{"repo": "x"}\n```\n', '## GitHub') as {repo: string})
      .repo,
    'x',
    'a heading on the first line of the body is found'
  );
  const runs = parseRuns(
    digestDoc([
      run('2026-09-29T10:00:00Z', [{repo: 'uhop/a', project: 'a', events: 1}]),
      run('2026-09-30T10:00:00Z', [{repo: 'uhop/b', project: 'b', events: 2}])
    ]).split('\n---\n')[1]!
  );
  t.deepEqual(
    runs.map(r => r.collected_at),
    ['2026-09-30T10:00:00Z', '2026-09-29T10:00:00Z'],
    'newest first whatever the file order'
  );
  t.deepEqual(
    parseRuns('## 2026-09-30\n\nno block here\n'),
    [],
    'a section without a block is skipped'
  );
});

test('parseSince: Nd and ISO', t => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  t.equal(parseSince('7d', now), '2026-09-23T12:00:00.000Z');
  t.equal(parseSince('2026-09-01', now), '2026-09-01T00:00:00.000Z');
  t.equal(parseSince('yesterday', now), null);
});

test('FleetStateRepository.apply keeps a record in step with its path', t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  const records = new RecordsRepository(db);
  const fleet = new FleetStateRepository(db);
  const insert = (path: string, body: string): string => {
    const id = `id-${path}`;
    records.insert({
      recordId: id,
      filePath: path,
      parentPath: null,
      sequenceKey: null,
      type: 'permanent',
      body,
      contentHash: 'h',
      bodyHash: 'h',
      title: null,
      created: '2026-09-01',
      updated: '2026-09-01',
      lastReferenced: null,
      decayScore: 1,
      status: 'active',
      priority: 0,
      archivedAt: null,
      agentSummary: null,
      agentDerivedFromHash: null,
      project: null
    });
    return id;
  };
  const stateBody = stateDoc('uhop/a', '2026-09-30T01:00:00Z', 3).split('\n---\n')[1]!;
  const a = insert('projects/a/state.md', stateBody);
  t.deepEqual(fleet.apply(a, 'projects/a/state.md', stateBody), {baselines: 1, runs: 0});
  t.deepEqual(
    fleet
      .baselines()
      .map(b => [
        b.project,
        b.repo,
        (b.github as {metadata: {stars: number}}).metadata.stars,
        b.packages !== null
      ]),
    [['a', 'uhop/a', 3, true]]
  );

  const noBlocks = insert('projects/b/state.md', 'Only the drift baseline, no fenced blocks.');
  t.deepEqual(fleet.apply(noBlocks, 'projects/b/state.md', 'Only prose'), {baselines: 0, runs: 0});
  t.equal(fleet.baselines().length, 1, 'a state.md without blocks has no row');

  const digestBody = digestDoc([
    run('2026-09-29T10:00:00Z', [{repo: 'uhop/a', project: 'a', events: 1}]),
    run('2026-09-30T10:00:00Z', [{repo: 'uhop/b', project: 'b', events: 2}])
  ]).split('\n---\n')[1]!;
  const d = insert(DIGEST_PATH, digestBody);
  t.deepEqual(fleet.apply(d, DIGEST_PATH, digestBody), {baselines: 0, runs: 2});
  t.equal(fleet.runs('', 10).length, 2);
  t.equal(fleet.runs('2026-09-30', 10).length, 1, 'since bounds the runs');
  t.equal(fleet.runs('', 1).length, 1, 'the limit caps them');

  // Re-applying with fewer runs drops the ones no longer in the note.
  const shorter = digestDoc([
    run('2026-09-30T10:00:00Z', [{repo: 'uhop/b', project: 'b', events: 2}])
  ]).split('\n---\n')[1]!;
  fleet.apply(d, DIGEST_PATH, shorter);
  t.equal(fleet.runs('', 10).length, 1, 'a run gone from the note is gone from the table');

  // A rename away from projects/<name>/state.md clears the record's row.
  t.deepEqual(fleet.apply(a, 'projects/a/notes.md', stateBody), {baselines: 0, runs: 0});
  t.equal(fleet.baselines().length, 0, 'the row went with the path');

  // The rows go with a deleted record.
  fleet.apply(a, 'projects/a/state.md', stateBody);
  records.delete(a);
  t.equal(fleet.baselines().length, 0, 'cascade on delete');
  records.delete(d);
  t.equal(fleet.runs('', 10).length, 0, 'runs cascade too');
  db.close();
});

interface Ctx {
  root: string;
  handle: ServerHandle;
  url: string;
}

const start = async (seedFn: (root: string) => void): Promise<Ctx> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-fleet-'));
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
const get = async (url: string, init: RequestInit = {}): Promise<{status: number; body: any}> => {
  const res = await fetch(url, {
    ...init,
    headers: {Authorization: `Bearer ${TEST_TOKEN}`, ...(init.headers ?? {})}
  });
  const text = await res.text();
  return {status: res.status, body: text ? JSON.parse(text) : null};
};

test('GET /fleet/status: the import fills the derivative, and the route reads it', async t => {
  const ctx = await start(root => {
    writeMd(root, 'projects/alpha/state.md', stateDoc('uhop/alpha', '2026-09-30T01:00:00Z', 5));
    writeMd(
      root,
      'projects/beta/state.md',
      stateDoc('uhop/beta', '2026-09-29T01:00:00Z', 2, false)
    );
    writeMd(root, 'projects/gamma/state.md', `${fm('gamma — State')}\nNo fleet blocks here.\n`);
    writeMd(
      root,
      DIGEST_PATH,
      digestDoc([
        run('2026-09-28T10:00:00Z', [{repo: 'uhop/alpha', project: 'alpha', events: 1}]),
        run('2026-09-29T10:00:00Z', [
          {repo: 'uhop/alpha', project: 'alpha', events: 2},
          {repo: 'uhop/beta', project: 'beta', events: 1}
        ]),
        run('2026-09-30T10:00:00Z', [{repo: 'uhop/beta', project: 'beta', events: 3}])
      ])
    );
  });
  try {
    const all = await get(`${ctx.url}/fleet/status`);
    t.equal(all.status, 200);
    t.deepEqual(
      all.body.baselines.map((b: any) => [
        b.project,
        b.repo,
        b.github.metadata.stars,
        b.packages === null
      ]),
      [
        ['alpha', 'uhop/alpha', 5, false],
        ['beta', 'uhop/beta', 2, true]
      ],
      'one baseline per state.md with blocks, by project; gamma has none'
    );
    t.deepEqual(
      all.body.runs.map((r: any) => r.collected_at),
      ['2026-09-30T10:00:00Z', '2026-09-29T10:00:00Z', '2026-09-28T10:00:00Z'],
      'every run, newest first'
    );
    t.ok(typeof all.body.as_of?.generation === 'number');
    t.equal(all.body.project, undefined, 'no project echo without the parameter');

    const alpha = await get(`${ctx.url}/fleet/status?project=alpha`);
    t.equal(alpha.body.project, 'alpha');
    t.equal(alpha.body.baselines.length, 1);
    t.deepEqual(
      alpha.body.runs.map((r: any) => [r.collected_at, r.repos.map((x: any) => x.repo)]),
      [
        ['2026-09-29T10:00:00Z', ['uhop/alpha']],
        ['2026-09-28T10:00:00Z', ['uhop/alpha']]
      ],
      'each run narrowed to the project, the run without it dropped'
    );
    t.deepEqual(
      alpha.body.runs[0].totals,
      {repos: 2, events: 3},
      'the rest of the run is as stored'
    );

    const since = await get(`${ctx.url}/fleet/status?since=2026-09-29T00:00:00Z&runs=1`);
    t.deepEqual(
      since.body.runs.map((r: any) => r.collected_at),
      ['2026-09-30T10:00:00Z'],
      'since and the cap'
    );
    const none = await get(`${ctx.url}/fleet/status?runs=0`);
    t.deepEqual(none.body.runs, [], 'runs=0 leaves them out');
    t.equal(none.body.baselines.length, 2);

    const missing = await get(`${ctx.url}/fleet/status?project=nope`);
    t.deepEqual(
      missing.body,
      {...missing.body, baselines: [], runs: []},
      'an unknown project is empty, not an error'
    );

    for (const q of ['project=Bad_Name', 'since=yesterday', 'runs=-1', 'runs=x', 'x=1']) {
      t.equal((await get(`${ctx.url}/fleet/status?${q}`)).status, 400, `${q} is a 400`);
    }

    // A rename keeps the record and moves the baseline to the new project.
    const moved = await get(`${ctx.url}/vault/move`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({from: 'projects/beta/state.md', to: 'projects/delta/state.md'})
    });
    t.equal(moved.status, 204);
    t.deepEqual(
      (await get(`${ctx.url}/fleet/status?runs=0`)).body.baselines.map((b: any) => b.project),
      ['alpha', 'delta'],
      'the baseline follows the path'
    );
    const gone = await get(`${ctx.url}/vault/projects/delta/state.md`, {method: 'DELETE'});
    t.equal(gone.status, 204);
    t.deepEqual(
      (await get(`${ctx.url}/fleet/status?runs=0`)).body.baselines.map((b: any) => b.project),
      ['alpha'],
      'a deleted state.md takes its baseline along'
    );
  } finally {
    await stop(ctx);
  }
});
