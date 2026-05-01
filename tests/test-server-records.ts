import test from 'tape-six';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-records';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setupVault = (): {root: string; cleanup: () => void} => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-records-test-'));
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
  gitAuthorEmail: 'vault-storage@localhost'
});

const startTestServer = async (
  vaultRoot: string
): Promise<{db: DatabaseSync; handle: ServerHandle; url: string}> => {
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

const teardown = async (db: DatabaseSync, handle: ServerHandle): Promise<void> => {
  await handle.close();
  db.close();
};

const authedFetch = async (
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

const seedVault = (root: string): void => {
  writeMd(
    root,
    'topics/alpha.md',
    [
      '---',
      'title: Alpha',
      'tags: []',
      'created: 2026-04-01',
      'updated: 2026-04-15',
      'priority: 5',
      '---',
      'Alpha topic body.',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'topics/beta.md',
    [
      '---',
      'title: Beta',
      'created: 2026-04-10',
      'updated: 2026-04-20',
      'priority: 0',
      '---',
      'Beta topic body.',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'logs/2026-04-25-x.md',
    ['---', 'title: Log', 'created: 2026-04-25', 'updated: 2026-04-25', '---', 'Log body.', ''].join('\n')
  );
  writeMd(
    root,
    'projects/demo/queue.md',
    [
      '---',
      'title: Demo queue',
      'created: 2026-04-22',
      'updated: 2026-04-22',
      'status: draft',
      '---',
      'queue body',
      ''
    ].join('\n')
  );
};

test('GET /sections lists records with pagination envelope', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedVault(root);
    const {db, handle, url} = await startTestServer(root);
    try {
      const {status, body} = await authedFetch(`${url}/sections`);
      t.equal(status, 200, '200 ok');
      const env = body as {items: unknown[]; offset: number; limit: number; total: number};
      t.equal(env.total, 4, 'total=4');
      t.equal(env.offset, 0, 'default offset=0');
      t.equal(env.limit, 20, 'default limit=20');
      t.equal(env.items.length, 4, 'all four items returned');
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections?type=permanent filters by type', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedVault(root);
    const {db, handle, url} = await startTestServer(root);
    try {
      const {status, body} = await authedFetch(`${url}/sections?type=permanent`);
      t.equal(status, 200, '200 ok');
      const env = body as {items: Array<{type: string}>; total: number};
      t.equal(env.total, 2, 'two permanent records (topics/*)');
      t.ok(
        env.items.every(i => i.type === 'permanent'),
        'all returned items are type=permanent'
      );
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections?file_prefix= filters by path prefix', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedVault(root);
    const {db, handle, url} = await startTestServer(root);
    try {
      const {status, body} = await authedFetch(`${url}/sections?file_prefix=topics/`);
      t.equal(status, 200, '200 ok');
      const env = body as {items: Array<{file_path: string}>; total: number};
      t.equal(env.total, 2, 'two items under topics/');
      t.ok(env.items.every(i => i.file_path.startsWith('topics/')), 'all paths under topics/');
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections?priority_min=1 filters by priority lower bound', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedVault(root);
    const {db, handle, url} = await startTestServer(root);
    try {
      const {status, body} = await authedFetch(`${url}/sections?priority_min=1`);
      t.equal(status, 200, '200 ok');
      const env = body as {items: Array<{priority: number}>; total: number};
      t.equal(env.total, 1, 'only alpha (priority=5) qualifies');
      t.equal(env.items[0]?.priority, 5, 'returned alpha');
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections?limit clamps above 100', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedVault(root);
    const {db, handle, url} = await startTestServer(root);
    try {
      const {status, body} = await authedFetch(`${url}/sections?limit=10000`);
      t.equal(status, 200, '200 ok');
      t.equal((body as {limit: number}).limit, 100, 'limit clamped to 100');
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections?type=bogus returns 400', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedVault(root);
    const {db, handle, url} = await startTestServer(root);
    try {
      const {status, body} = await authedFetch(`${url}/sections?type=bogus`);
      t.equal(status, 400, '400 bad request');
      t.equal((body as {code: string}).code, 'bad_request', 'code=bad_request');
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections/{id} returns the record with body', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedVault(root);
    const {db, handle, url} = await startTestServer(root);
    try {
      // First find an id via the list endpoint.
      const list = await authedFetch(`${url}/sections?file_path=topics/alpha.md`);
      const id = (list.body as {items: Array<{record_id: string}>}).items[0]?.record_id;
      t.ok(id, 'found record_id for topics/alpha.md');

      const {status, body} = await authedFetch(`${url}/sections/${id}`);
      t.equal(status, 200, '200 ok');
      const r = body as {file_path: string; body: string};
      t.equal(r.file_path, 'topics/alpha.md', 'right file_path');
      t.equal(r.body, 'Alpha topic body.\n', 'body included by default');
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections/{id} surfaces both content_hash and body_hash', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedVault(root);
    const {db, handle, url} = await startTestServer(root);
    try {
      const list = await authedFetch(`${url}/sections?file_path=topics/alpha.md`);
      const id = (list.body as {items: Array<{record_id: string}>}).items[0]?.record_id;
      const {body} = await authedFetch(`${url}/sections/${id}`);
      const r = body as {body: string; content_hash: string; body_hash: string};
      // For unenriched records (no agent.summary), body_hash and content_hash
      // must agree — both equal `sha256(body)`. The split matters only once
      // a summary is mixed into content_hash via embedInputHash.
      t.equal(typeof r.body_hash, 'string', 'body_hash present');
      t.equal(r.body_hash.length, 64, 'body_hash is sha256 hex');
      t.equal(r.body_hash, r.content_hash, 'body_hash == content_hash for unenriched record');
      const {createHash} = await import('node:crypto');
      const expected = createHash('sha256').update(r.body).digest('hex');
      t.equal(r.body_hash, expected, 'body_hash == sha256(body)');
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections/{id} bumps last_referenced (decay reinforcement)', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedVault(root);
    const {db, handle, url} = await startTestServer(root);
    try {
      const list = await authedFetch(`${url}/sections?file_path=topics/alpha.md`);
      const id = (list.body as {items: Array<{record_id: string}>}).items[0]?.record_id ?? '';

      // Snapshot before — no read has happened yet.
      const before = db
        .prepare('SELECT last_referenced FROM records WHERE record_id = ?')
        .get(id) as {last_referenced: string | null};
      t.equal(before.last_referenced, null, 'last_referenced starts null');

      await authedFetch(`${url}/sections/${id}`);

      const after = db
        .prepare('SELECT last_referenced FROM records WHERE record_id = ?')
        .get(id) as {last_referenced: string | null};
      t.ok(typeof after.last_referenced === 'string', 'last_referenced now set');
      t.ok(
        Date.parse(after.last_referenced!) > Date.now() - 5_000,
        'set to ~now (within 5s)'
      );
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections/{id} response includes decay_score field', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedVault(root);
    const {db, handle, url} = await startTestServer(root);
    try {
      const list = await authedFetch(`${url}/sections?file_path=topics/alpha.md`);
      const id = (list.body as {items: Array<{record_id: string}>}).items[0]?.record_id ?? '';

      const {body} = await authedFetch(`${url}/sections/${id}`);
      const r = body as {decay_score: number};
      t.equal(typeof r.decay_score, 'number', 'decay_score present');
      // Just-bumped on this read → score = 1.0 (within float tolerance).
      t.ok(r.decay_score > 0.999, `decay_score ~1.0 immediately after read; got ${r.decay_score}`);
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections/{id} bulk listing does NOT bump last_referenced', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedVault(root);
    const {db, handle, url} = await startTestServer(root);
    try {
      // Bulk listing — should NOT cascade-bump every record's clock.
      await authedFetch(`${url}/sections?type=permanent&limit=50`);
      const rows = db
        .prepare('SELECT last_referenced FROM records')
        .all() as Array<{last_referenced: string | null}>;
      const bumped = rows.filter(r => r.last_referenced !== null).length;
      t.equal(bumped, 0, 'bulk list does not bump');
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections/{id}?exclude=body omits body', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedVault(root);
    const {db, handle, url} = await startTestServer(root);
    try {
      const list = await authedFetch(`${url}/sections?file_path=topics/alpha.md`);
      const id = (list.body as {items: Array<{record_id: string}>}).items[0]?.record_id;
      const {status, body} = await authedFetch(`${url}/sections/${id}?exclude=body`);
      t.equal(status, 200, '200 ok');
      t.equal('body' in (body as object), false, 'body field absent');
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections/{id}/meta returns frontmatter projection only', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedVault(root);
    const {db, handle, url} = await startTestServer(root);
    try {
      const list = await authedFetch(`${url}/sections?file_path=topics/alpha.md`);
      const id = (list.body as {items: Array<{record_id: string}>}).items[0]?.record_id;
      const {status, body} = await authedFetch(`${url}/sections/${id}/meta`);
      t.equal(status, 200, '200 ok');
      t.equal('body' in (body as object), false, 'meta endpoint omits body');
      t.equal((body as {file_path: string}).file_path, 'topics/alpha.md', 'has file_path');
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections/{unknown-id} returns 404', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedVault(root);
    const {db, handle, url} = await startTestServer(root);
    try {
      const {status, body} = await authedFetch(`${url}/sections/01HFFFFFFFFFFFFFFFFFFFFFFFFF`);
      t.equal(status, 404, '404 not found');
      t.equal((body as {code: string}).code, 'record_not_found', 'code=record_not_found');
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});
