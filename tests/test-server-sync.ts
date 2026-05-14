import test from 'tape-six';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-sync';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setup = (): {source: string; target: string; cleanup: () => void} => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-storage-server-sync-test-'));
  const source = join(dir, 'obsidian');
  const target = join(dir, 'vault-data');
  mkdirSync(source, {recursive: true});
  mkdirSync(target, {recursive: true});
  return {source, target, cleanup: () => rmSync(dir, {recursive: true, force: true})};
};

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

interface ServerCtx {
  db: DatabaseSync;
  handle: ServerHandle;
  url: string;
}

const startTestServer = async (target: string): Promise<ServerCtx> => {
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  const handle = await startServer({
    db,
    env: makeEnv(0, target),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {db, handle, url: `http://127.0.0.1:${port}`};
};

const teardown = async ({db, handle}: ServerCtx): Promise<void> => {
  await handle.close();
  db.close();
};

const fetchAuthed = async (
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

const fm = (data: Record<string, unknown>, body: string): string => {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) lines.push(`${k}: [${(v as unknown[]).join(', ')}]`);
    else lines.push(`${k}: ${v}`);
  }
  lines.push('---');
  return lines.join('\n') + '\n' + body + '\n';
};

test('POST /sync/from-obsidian writes new files and returns counts envelope', async t => {
  const {source, target, cleanup} = setup();
  try {
    writeMd(source, 'topics/alpha.md', fm({title: 'Alpha'}, 'Alpha.'));
    writeMd(source, 'topics/beta.md', fm({title: 'Beta'}, 'Beta.'));
    const ctx = await startTestServer(target);
    try {
      const r = await fetchAuthed(`${ctx.url}/sync/from-obsidian`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source_path: source, write_log: false})
      });
      t.equal(r.status, 200, '200 ok');
      const env = r.body as {
        total: number;
        new: number;
        updated: number;
        skipped_locally_newer: number;
        files: unknown[];
      };
      t.equal(env.total, 2, 'two source files');
      t.equal(env.new, 2, 'two new');
      t.equal(env.updated, 0, 'zero updated');
      t.equal(env.skipped_locally_newer, 0, 'zero locally newer');
      t.equal(env.files.length, 2, 'two file entries returned');
      t.ok(existsSync(join(target, 'topics/alpha.md')), 'alpha written');
      t.ok(existsSync(join(target, 'topics/beta.md')), 'beta written');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /sync/from-obsidian dry_run reports without writing', async t => {
  const {source, target, cleanup} = setup();
  try {
    writeMd(source, 'topics/alpha.md', fm({title: 'Alpha'}, 'Alpha.'));
    const ctx = await startTestServer(target);
    try {
      const r = await fetchAuthed(`${ctx.url}/sync/from-obsidian`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source_path: source, dry_run: true, write_log: false})
      });
      t.equal(r.status, 200, '200 ok');
      const env = r.body as {new: number; log_path: string | null};
      t.equal(env.new, 1, 'reports as new');
      t.equal(env.log_path, null, 'no log written in dry-run');
      t.equal(existsSync(join(target, 'topics/alpha.md')), false, 'target NOT written');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /sync/from-obsidian rejects missing source_path', async t => {
  const {target, cleanup} = setup();
  try {
    const ctx = await startTestServer(target);
    try {
      const r = await fetchAuthed(`${ctx.url}/sync/from-obsidian`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({})
      });
      t.equal(r.status, 400, '400 bad request');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /sync/from-obsidian rejects nonexistent source path', async t => {
  const {target, cleanup} = setup();
  try {
    const ctx = await startTestServer(target);
    try {
      const r = await fetchAuthed(`${ctx.url}/sync/from-obsidian`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source_path: '/no/such/place'})
      });
      t.equal(r.status, 400, '400 bad request');
      t.equal((r.body as {code: string}).code, 'invalid_path', 'invalid_path code');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /sync/from-obsidian write_log defaults to true and writes a log file', async t => {
  const {source, target, cleanup} = setup();
  try {
    writeMd(source, 'topics/alpha.md', fm({title: 'Alpha'}, 'Alpha.'));
    const ctx = await startTestServer(target);
    try {
      const r = await fetchAuthed(`${ctx.url}/sync/from-obsidian`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source_path: source})
      });
      t.equal(r.status, 200, '200 ok');
      const env = r.body as {log_path: string | null};
      t.ok(env.log_path, 'log_path set');
      t.ok(env.log_path!.startsWith('logs/sync/'), 'log under logs/sync/');
      t.ok(existsSync(join(target, env.log_path!)), 'log file exists');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});
