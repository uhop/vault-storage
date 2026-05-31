import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-options';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setupVault = (): {root: string; cleanup: () => void} => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-options-test-'));
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

const startTestServer = async (vaultRoot: string): Promise<ServerCtx> => {
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, vaultRoot);
  const handle = await startServer({
    db,
    env: makeEnv(0, vaultRoot),
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

const seed = (root: string): void => {
  writeMd(
    root,
    'topics/alpha.md',
    ['---', 'title: Alpha', '---', 'Alpha body.', ''].join('\n')
  );
};

// Parse an `Allow` header into a Set of verbs for order-independent assertions.
const allowSet = (header: string | null): Set<string> =>
  new Set((header ?? '').split(',').map(s => s.trim()).filter(Boolean));

test('OPTIONS /vault/{path} returns 204 with Allow listing the verbs', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const res = await fetch(`${ctx.url}/vault/topics/alpha.md`, {
        method: 'OPTIONS',
        headers: {Authorization: `Bearer ${TEST_TOKEN}`}
      });
      t.equal(res.status, 204, '204 no content');
      const allow = allowSet(res.headers.get('allow'));
      t.ok(allow.has('GET'), 'Allow has GET');
      t.ok(allow.has('PUT'), 'Allow has PUT');
      t.ok(allow.has('DELETE'), 'Allow has DELETE');
      t.ok(allow.has('OPTIONS'), 'Allow has OPTIONS');
      t.equal(await res.text(), '', 'empty body');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('OPTIONS works without a bearer token (safe discovery / CORS preflight)', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      // No Authorization header — a real GET here would 401.
      const res = await fetch(`${ctx.url}/vault/topics/alpha.md`, {method: 'OPTIONS'});
      t.equal(res.status, 204, '204 even unauthenticated');
      t.ok(allowSet(res.headers.get('allow')).has('GET'), 'Allow still populated');

      const get = await fetch(`${ctx.url}/vault/topics/alpha.md`);
      t.equal(get.status, 401, 'GET without token still 401 — OPTIONS leaks no data');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('OPTIONS reflects a single-method route (POST-only /search/simple/)', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const res = await fetch(`${ctx.url}/search/simple/`, {
        method: 'OPTIONS',
        headers: {Authorization: `Bearer ${TEST_TOKEN}`}
      });
      t.equal(res.status, 204, '204 no content');
      const allow = allowSet(res.headers.get('allow'));
      t.ok(allow.has('POST'), 'Allow has POST');
      t.ok(allow.has('OPTIONS'), 'Allow has OPTIONS');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('OPTIONS on an unknown path returns 404', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const res = await fetch(`${ctx.url}/no/such/route`, {
        method: 'OPTIONS',
        headers: {Authorization: `Bearer ${TEST_TOKEN}`}
      });
      t.equal(res.status, 404, '404 not found for an unrouted path');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('405 response carries an Allow header (RFC 7231)', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      // /search/simple/ is POST-only; PUT is method-not-allowed.
      const res = await fetch(`${ctx.url}/search/simple/`, {
        method: 'PUT',
        headers: {Authorization: `Bearer ${TEST_TOKEN}`}
      });
      t.equal(res.status, 405, '405 method not allowed');
      const allow = allowSet(res.headers.get('allow'));
      t.ok(allow.has('POST'), 'Allow names the supported POST');
      t.ok(allow.has('OPTIONS'), 'Allow includes OPTIONS');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});
