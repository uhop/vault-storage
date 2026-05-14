import test from 'tape-six';
import {execSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-commit';

const initRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'vault-commit-test-'));
  execSync('git init -q -b main', {cwd: root});
  execSync('git config user.email tester@example.com', {cwd: root});
  execSync('git config user.name Tester', {cwd: root});
  writeFileSync(join(root, 'README.md'), '# vault\n');
  execSync('git add -A', {cwd: root});
  execSync('git commit -q -m initial', {cwd: root});
  return root;
};

const cleanup = (root: string): void => rmSync(root, {recursive: true, force: true});

const log = (cwd: string): string[] =>
  execSync('git log --format=%s', {cwd}).toString().trim().split('\n').filter(Boolean);

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

const startTestServer = async (vaultRoot: string): Promise<ServerCtx> => {
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  const handle = await startServer({
    db,
    env: makeEnv(0, vaultRoot),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {db, handle, url: `http://127.0.0.1:${port}`, root: vaultRoot};
};

const teardown = async ({db, handle, root}: ServerCtx): Promise<void> => {
  await handle.close();
  db.close();
  cleanup(root);
};

const fetchJson = async (
  url: string,
  init: RequestInit = {}
): Promise<{status: number; body: unknown}> => {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${TEST_TOKEN}`);
  const res = await fetch(url, {...init, headers});
  const text = await res.text();
  const body = text.length === 0 ? null : JSON.parse(text);
  return {status: res.status, body};
};

test('POST /commit commits dirty changes with default message', async t => {
  const ctx = await startTestServer(initRepo());
  try {
    mkdirSync(join(ctx.root, 'topics'), {recursive: true});
    writeFileSync(join(ctx.root, 'topics/note.md'), 'body\n');

    const {status, body} = await fetchJson(`${ctx.url}/commit`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({})
    });
    t.equal(status, 200, '200 ok');
    const r = body as {committed: boolean; sha: string; files: string[]; message: string};
    t.equal(r.committed, true, 'committed=true');
    t.ok(r.sha?.length === 40, 'sha is 40 chars');
    t.ok(r.message.startsWith('vault-storage manual commit'), 'default message used');
    t.ok(r.files.length >= 1, 'at least one file in the commit');

    const commits = log(ctx.root);
    t.equal(commits.length, 2, 'one new commit on the log');
    t.equal(commits[0], r.message, 'commit subject matches response');
  } finally {
    await teardown(ctx);
  }
});

test('POST /commit honors a custom message', async t => {
  const ctx = await startTestServer(initRepo());
  try {
    writeFileSync(join(ctx.root, 'note.md'), 'hello\n');
    const {body} = await fetchJson(`${ctx.url}/commit`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message: 'enrichment batch — 5 records'})
    });
    const r = body as {committed: boolean; message: string};
    t.equal(r.committed, true, 'committed');
    t.equal(r.message, 'enrichment batch — 5 records', 'custom message used');
    t.equal(log(ctx.root)[0], 'enrichment batch — 5 records', 'custom message in log');
  } finally {
    await teardown(ctx);
  }
});

test('POST /commit with paths only stages those paths', async t => {
  const ctx = await startTestServer(initRepo());
  try {
    writeFileSync(join(ctx.root, 'a.md'), 'a\n');
    writeFileSync(join(ctx.root, 'b.md'), 'b\n');

    const {body} = await fetchJson(`${ctx.url}/commit`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message: 'just a', paths: ['a.md']})
    });
    const r = body as {committed: boolean; files: string[]};
    t.equal(r.committed, true, 'committed');
    t.deepEqual(r.files, ['a.md'], 'only a.md staged');

    // b.md should still be unstaged in the working tree.
    const status = execSync('git status --porcelain', {cwd: ctx.root}).toString();
    t.ok(status.includes('?? b.md'), 'b.md still untracked after commit');
  } finally {
    await teardown(ctx);
  }
});

test('POST /commit returns committed=false on a clean tree', async t => {
  const ctx = await startTestServer(initRepo());
  try {
    const {body} = await fetchJson(`${ctx.url}/commit`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({})
    });
    const r = body as {committed: boolean; reason?: string};
    t.equal(r.committed, false, 'committed=false');
    t.equal(r.reason, 'nothing-to-commit', 'reason field');
    t.equal(log(ctx.root).length, 1, 'no new commit added');
  } finally {
    await teardown(ctx);
  }
});

test('POST /commit advances meta.last_indexed_commit', async t => {
  const ctx = await startTestServer(initRepo());
  try {
    writeFileSync(join(ctx.root, 'note.md'), 'note\n');
    const {body} = await fetchJson(`${ctx.url}/commit`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({})
    });
    const r = body as {sha: string};

    const meta = ctx.db
      .prepare(`SELECT value FROM meta WHERE key = 'last_indexed_commit'`)
      .get() as {value: string} | undefined;
    t.equal(meta?.value, r.sha, 'last_indexed_commit advanced to new HEAD');
  } finally {
    await teardown(ctx);
  }
});

test('POST /commit 400 on invalid message type', async t => {
  const ctx = await startTestServer(initRepo());
  try {
    const {status} = await fetchJson(`${ctx.url}/commit`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({message: 42})
    });
    t.equal(status, 400, '400 bad request');
  } finally {
    await teardown(ctx);
  }
});

test('POST /commit 400 on path traversal', async t => {
  const ctx = await startTestServer(initRepo());
  try {
    const {status} = await fetchJson(`${ctx.url}/commit`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({paths: ['../escape.md']})
    });
    t.equal(status, 400, '400 bad path');
  } finally {
    await teardown(ctx);
  }
});

test('POST /commit 400 on empty paths array', async t => {
  const ctx = await startTestServer(initRepo());
  try {
    const {status} = await fetchJson(`${ctx.url}/commit`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({paths: []})
    });
    t.equal(status, 400, '400 empty paths');
  } finally {
    await teardown(ctx);
  }
});

test('POST /commit 503 on a non-git directory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vault-commit-nogit-'));
  const ctx = await startTestServer(root);
  try {
    const {status, body} = await fetchJson(`${ctx.url}/commit`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({})
    });
    t.equal(status, 503, '503 not a git repo');
    t.equal((body as {code: string}).code, 'not_a_git_repo', 'code field present');
  } finally {
    await teardown(ctx);
  }
});

test('POST /commit requires bearer auth', async t => {
  const ctx = await startTestServer(initRepo());
  try {
    const res = await fetch(`${ctx.url}/commit`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: '{}'
    });
    t.equal(res.status, 401, '401 unauthorized');
  } finally {
    await teardown(ctx);
  }
});
