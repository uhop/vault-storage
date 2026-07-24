import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import {QueueItemsRepository} from '../src/queue/repo.ts';
import {syncQueueFile} from '../src/queue/sync.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-brief';

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
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const seed = (root: string): void => {
  writeMd(
    root,
    'projects/vs-demo/feedback.md',
    [
      '---',
      'title: vs-demo — Feedback',
      'type: project',
      'created: 2026-07-01',
      'updated: 2026-07-09',
      '---',
      'Rules the brief must never inline.',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'logs/2026-07-22-last-session.md',
    [
      '---',
      'title: Last session',
      'type: log',
      'created: 2026-07-22',
      'updated: 2026-07-22',
      '---',
      'A long log body the brief must not carry.',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'projects/vs-demo/queue.md',
    [
      '---',
      'title: vs-demo — Queue',
      'type: project',
      '---',
      '',
      '## Active',
      '',
      '- **Mid-flight thing.** in progress',
      '',
      '## Backlog',
      '',
      '- **Free item.** startable',
      '- **Stuck item.** waits',
      '  - blocked-by: Free item.',
      '',
      '## Watching',
      ''
    ].join('\n')
  );
};

const withServer = async (fn: (url: string) => Promise<void>): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-resume-brief-'));
  seed(root);
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, root);
  syncQueueFile(new QueueItemsRepository(db), 'projects/vs-demo/queue.md', root);
  const handle = await startServer({
    db,
    env: makeEnv(0, root),
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

const fetchRaw = async (url: string): Promise<{status: number; raw: string}> => {
  const res = await fetch(url, {headers: {Authorization: `Bearer ${TEST_TOKEN}`}});
  return {status: res.status, raw: await res.text()};
};

test('GET /system/resume-brief — fleet shape, no bodies, small payload', async t => {
  await withServer(async url => {
    const {status, raw} = await fetchRaw(`${url}/system/resume-brief`);
    t.equal(status, 200);
    t.ok(raw.length < 1024, `payload stays brief (${raw.length} bytes)`);
    t.notOk(raw.includes('must not carry'), 'no log bodies');
    const body = JSON.parse(raw) as {
      lint: {ok: boolean; total_issues: number};
      suggestions_pending: number;
      workflow: {active: boolean; clarify_pending: number | null};
      latest_log: {file_path: string; title: string | null; updated: string};
      project: null;
    };
    t.equal(typeof body.lint.ok, 'boolean');
    t.equal(typeof body.suggestions_pending, 'number');
    t.equal(body.workflow.active, false, 'no agent-workflow surface seeded');
    t.equal(body.latest_log.file_path, 'logs/2026-07-22-last-session.md');
    t.equal(body.project, null, 'no project block without ?project=');
  });
});

test('GET /system/resume-brief?project= — queue counts + feedback pointer, still no bodies', async t => {
  await withServer(async url => {
    const {status, raw} = await fetchRaw(`${url}/system/resume-brief?project=vs-demo`);
    t.equal(status, 200);
    t.notOk(raw.includes('never inline'), 'feedback body not inlined');
    const body = JSON.parse(raw) as {
      project: {
        name: string;
        queue: {active: string[]; backlog: number; ready: number; blocked: number};
        feedback: {updated: string} | null;
      };
    };
    t.deepEqual(body.project.queue.active, ['Mid-flight thing.']);
    t.equal(body.project.queue.backlog, 2, 'two backlog items');
    t.equal(body.project.queue.ready, 1, 'only the unblocked one is ready');
    t.equal(body.project.queue.blocked, 1, 'the ref-carrying one is blocked');
    t.equal(body.project.feedback?.updated, '2026-07-09');
  });
});

test('GET /system/resume-brief — validation is loud', async t => {
  await withServer(async url => {
    const unknown = await fetchRaw(`${url}/system/resume-brief?proejct=vs-demo`);
    t.equal(unknown.status, 400, 'unknown query param 400s');
    t.ok(unknown.raw.includes('proejct'), 'offender named');

    const badName = await fetchRaw(`${url}/system/resume-brief?project=Not%20Kebab`);
    t.equal(badName.status, 400, 'non-kebab project 400s');
  });
});
