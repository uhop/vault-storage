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

const TEST_TOKEN = 'test-token-resolve';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setupVault = (): {root: string; cleanup: () => void} => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-resolve-test-'));
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
  commitIntervalMs: 60000,
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

const fetchJson = async (url: string): Promise<{status: number; body: unknown}> => {
  const res = await fetch(url, {headers: {Authorization: `Bearer ${TEST_TOKEN}`}});
  const text = await res.text();
  const body = text.length === 0 ? null : JSON.parse(text);
  return {status: res.status, body};
};

const seed = (root: string): void => {
  writeMd(
    root,
    'topics/alpha.md',
    '---\ntitle: Alpha\ncreated: 2026-04-01\nupdated: 2026-04-15\n---\nAlpha body.\n'
  );
  writeMd(
    root,
    'topics/beta.md',
    '---\ntitle: Beta\ncreated: 2026-04-10\nupdated: 2026-04-20\n---\nBeta body.\n'
  );
  // Folder + _about.md mimics atomization output for folder-fallback resolution
  writeMd(
    root,
    'projects/demo/_about.md',
    '---\ntitle: Demo project\ncreated: 2026-04-22\nupdated: 2026-04-22\n---\nDemo project root.\n'
  );
  // Two pieces with same basename (would otherwise be unique but let's keep them distinct)
  writeMd(
    root,
    'projects/demo/queue/item-one.md',
    '---\ntitle: Item one\ntype: queue-item\ncreated: 2026-04-22\nupdated: 2026-04-22\nsequence_key: 1\n---\nFirst.\n'
  );
};

test('GET /resolve resolves exact path (no .md)', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const {status, body} = await fetchJson(`${ctx.url}/resolve?wikilink=topics/alpha`);
      t.equal(status, 200, '200 ok');
      const r = body as {target: string; record_id: string; file_path: string; ui_url: string};
      t.equal(r.target, 'topics/alpha', 'target echoed');
      t.equal(r.file_path, 'topics/alpha.md', 'file_path resolved');
      t.ok(r.record_id.length > 0, 'record_id present');
      t.equal(r.ui_url, '/ui/note.html?path=topics%2Falpha.md', 'ui_url encoded');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /resolve resolves exact path with .md', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const {status, body} = await fetchJson(`${ctx.url}/resolve?wikilink=topics/beta.md`);
      t.equal(status, 200, '200 ok');
      const r = body as {file_path: string};
      t.equal(r.file_path, 'topics/beta.md', 'file_path matches');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /resolve resolves unique basename', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const {status, body} = await fetchJson(`${ctx.url}/resolve?wikilink=alpha`);
      t.equal(status, 200, 'unique basename resolves');
      t.equal((body as {file_path: string}).file_path, 'topics/alpha.md', 'right target');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /resolve folder fallback to _about.md', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const {status, body} = await fetchJson(`${ctx.url}/resolve?wikilink=projects/demo`);
      t.equal(status, 200, 'folder resolves to _about');
      t.equal(
        (body as {file_path: string}).file_path,
        'projects/demo/_about.md',
        'right target'
      );
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /resolve strips #anchor before lookup', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const {status, body} = await fetchJson(`${ctx.url}/resolve?wikilink=topics/alpha%23section`);
      t.equal(status, 200, 'page#anchor resolves to page');
      t.equal((body as {file_path: string}).file_path, 'topics/alpha.md', 'right target');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /resolve 404 on nonexistent wikilink', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const {status} = await fetchJson(`${ctx.url}/resolve?wikilink=nonexistent`);
      t.equal(status, 404, '404 not found');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /resolve 400 when wikilink missing', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const {status} = await fetchJson(`${ctx.url}/resolve`);
      t.equal(status, 400, '400 missing param');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /resolve 400 when wikilink empty', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const {status} = await fetchJson(`${ctx.url}/resolve?wikilink=`);
      t.equal(status, 400, '400 empty param');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /resolve requires bearer auth', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const res = await fetch(`${ctx.url}/resolve?wikilink=topics/alpha`);
      t.equal(res.status, 401, '401 unauthorized');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});
