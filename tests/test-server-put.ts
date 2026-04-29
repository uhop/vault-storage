import test from 'tape-six';
import {readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {importVault} from '../src/importer/import.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-put';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setupVault = (): {root: string; cleanup: () => void} => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-put-test-'));
  return {root, cleanup: () => rmSync(root, {recursive: true, force: true})};
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
  autoCommit: false,
  autoPush: false,
  commitIntervalMs: 60000
});

interface ServerCtx {
  db: DatabaseSync;
  handle: ServerHandle;
  url: string;
}

const startTestServer = async (vaultRoot: string): Promise<ServerCtx> => {
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, vaultRoot);
  const handle = await startServer({
    db,
    env: makeEnv(0, vaultRoot),
    schemaVersion: migration.current
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
): Promise<{status: number; body: unknown; raw: string}> => {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${TEST_TOKEN}`);
  const res = await fetch(url, {...init, headers});
  const raw = await res.text();
  const body = raw.length === 0 ? null : JSON.parse(raw);
  return {status: res.status, body, raw};
};

const seed = (root: string): void => {
  writeMd(
    root,
    'topics/alpha.md',
    [
      '---',
      'title: Alpha',
      'tags: []',
      'created: 2026-04-01',
      'updated: 2026-04-15',
      'priority: 0',
      '---',
      'Alpha original body.',
      ''
    ].join('\n')
  );
};

const findId = async (url: string, filePath: string): Promise<string> => {
  const list = await fetchAuthed(`${url}/sections?file_path=${encodeURIComponent(filePath)}`);
  return (list.body as {items: Array<{record_id: string}>}).items[0]!.record_id;
};

test('PUT /sections/{id} replaces body and updates frontmatter', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const id = await findId(ctx.url, 'topics/alpha.md');
      const newMd = ['---', 'title: Alpha v2', 'priority: 3', '---', 'New body content.', ''].join(
        '\n'
      );
      const put = await fetchAuthed(`${ctx.url}/sections/${id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: newMd
      });
      t.equal(put.status, 204, '204 no content');

      const onDisk = readFileSync(join(root, 'topics/alpha.md'), 'utf8');
      t.ok(onDisk.includes('title: Alpha v2'), 'title updated on disk');
      t.ok(onDisk.includes('priority: 3'), 'priority updated on disk');
      t.ok(onDisk.includes('created: 2026-04-01'), 'created preserved');
      t.ok(onDisk.includes('New body content.'), 'body replaced on disk');

      const get = await fetchAuthed(`${ctx.url}/sections/${id}`);
      const r = get.body as {body: string; priority: number; record_id: string};
      t.equal(r.priority, 3, 'priority reflected in DB');
      t.equal(r.body, 'New body content.\n', 'body reflected in DB');
      t.equal(r.record_id, id, 'record_id preserved');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /sections/{id} accepts body without frontmatter', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const id = await findId(ctx.url, 'topics/alpha.md');
      const put = await fetchAuthed(`${ctx.url}/sections/${id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: 'Just a body, no frontmatter.\n'
      });
      t.equal(put.status, 204, '204 no content');

      const onDisk = readFileSync(join(root, 'topics/alpha.md'), 'utf8');
      t.ok(onDisk.includes('title: Alpha'), 'title kept from existing frontmatter');
      t.ok(onDisk.includes('Just a body, no frontmatter.'), 'body replaced');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /sections/{id} rejects auto-managed frontmatter keys', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const id = await findId(ctx.url, 'topics/alpha.md');
      const newMd = [
        '---',
        'title: Alpha',
        "created: '2026-01-01'",
        '---',
        'body',
        ''
      ].join('\n');
      const put = await fetchAuthed(`${ctx.url}/sections/${id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: newMd
      });
      t.equal(put.status, 400, '400 bad request');
      t.equal(
        (put.body as {code: string}).code,
        'frontmatter_auto_managed',
        'code=frontmatter_auto_managed'
      );
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /sections/{unknown-id} returns 404', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const put = await fetchAuthed(`${ctx.url}/sections/01HFFFFFFFFFFFFFFFFFFFFFFFFFFF`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: 'whatever'
      });
      t.equal(put.status, 404, '404 not found');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});
