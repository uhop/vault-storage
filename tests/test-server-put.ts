import test from 'tape-six';
import {readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
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
  embedderRetentionMs: 1_800_000,
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

test('PUT /sections/{id} rejects DB-only frontmatter keys', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const id = await findId(ctx.url, 'topics/alpha.md');
      const newMd = [
        '---',
        'title: Alpha',
        "record_id: 'fake-id'",
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

test('PUT /sections/{id} rejects unknown status values (closed-enum hardening)', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const id = await findId(ctx.url, 'topics/alpha.md');
      const md = ['---', 'title: Alpha', 'status: not-a-real-status', '---', 'body', ''].join('\n');
      const put = await fetchAuthed(`${ctx.url}/sections/${id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: md
      });
      t.equal(put.status, 400);
      t.equal((put.body as {code: string}).code, 'invalid_enum_value');
      t.ok(
        ((put.body as {error: string}).error || '').includes('unknown status'),
        'error names the field'
      );
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /sections/{id} accepts legacy status aliases (round-trip safe)', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const id = await findId(ctx.url, 'topics/alpha.md');
      const md = ['---', 'title: Alpha', 'status: completed', '---', 'body', ''].join('\n');
      const put = await fetchAuthed(`${ctx.url}/sections/${id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: md
      });
      t.equal(put.status, 204, 'legacy alias accepted');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /sections/{id} rejects unknown type values', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const id = await findId(ctx.url, 'topics/alpha.md');
      const md = ['---', 'title: Alpha', 'type: madeup', '---', 'body', ''].join('\n');
      const put = await fetchAuthed(`${ctx.url}/sections/${id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: md
      });
      t.equal(put.status, 400);
      t.equal((put.body as {code: string}).code, 'invalid_enum_value');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /sections/{id} rejects unknown priority alias; integers and known aliases pass', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const id = await findId(ctx.url, 'topics/alpha.md');

      // Integer always OK.
      const intMd = ['---', 'title: Alpha', 'priority: 22', '---', 'body', ''].join('\n');
      let put = await fetchAuthed(`${ctx.url}/sections/${id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: intMd
      });
      t.equal(put.status, 204, 'integer priority accepted');

      // Known alias OK.
      const aliasMd = ['---', 'title: Alpha', 'priority: high', '---', 'body', ''].join('\n');
      put = await fetchAuthed(`${ctx.url}/sections/${id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: aliasMd
      });
      t.equal(put.status, 204, 'named alias accepted');

      // Unknown string rejected.
      const badMd = ['---', 'title: Alpha', 'priority: super-critical', '---', 'body', ''].join('\n');
      put = await fetchAuthed(`${ctx.url}/sections/${id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: badMd
      });
      t.equal(put.status, 400, 'unknown alias rejected');
      t.equal((put.body as {code: string}).code, 'invalid_enum_value');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /sections/{id} rejects double-frontmatter PUT bodies', async t => {
  // Defense against the 2026-05-01 sub-agent failure mode: a helper script
  // appended the original full file (FM + body) to a new FM block, the
  // writer would silently produce double-FM with no body. Reject at the
  // boundary so the caller's bug surfaces as a 400 instead of data loss.
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const id = await findId(ctx.url, 'topics/alpha.md');
      const malformed = [
        '---',
        'title: Alpha',
        'related:',
        '  - "[[other]]"',
        '---',
        '---',
        'title: Alpha',
        'tags: [foo]',
        '---',
        'original body'
      ].join('\n');
      const put = await fetchAuthed(`${ctx.url}/sections/${id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: malformed
      });
      t.equal(put.status, 400, '400 bad request');
      t.equal(
        (put.body as {code: string}).code,
        'malformed_double_frontmatter',
        'code=malformed_double_frontmatter'
      );

      // Body should be unchanged on disk — no partial write.
      const onDisk = readFileSync(join(root, 'topics/alpha.md'), 'utf8');
      t.ok(onDisk.includes('Alpha original body.'), 'on-disk body untouched');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /sections/{id} allows body with thematic-break `---` (single, no closing)', async t => {
  // A body that begins with `---` but no closing `---` line within 50 lines
  // is a thematic break, not a malformed FM block. Allow.
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const id = await findId(ctx.url, 'topics/alpha.md');
      const md = [
        '---',
        'title: Alpha',
        '---',
        '---',
        '',
        'Body after a thematic-break opening, no closing dash-line within 50.',
        ''
      ].join('\n');
      const put = await fetchAuthed(`${ctx.url}/sections/${id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: md
      });
      t.equal(put.status, 204, 'thematic-break body accepted');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /sections/{id} accepts created/updated round-trip; indexer overrides', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const id = await findId(ctx.url, 'topics/alpha.md');
      const newMd = [
        '---',
        'title: Alpha',
        "created: '2099-01-01'",
        "updated: '2099-01-01'",
        '---',
        'Round-trip body.',
        ''
      ].join('\n');
      const put = await fetchAuthed(`${ctx.url}/sections/${id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: newMd
      });
      t.equal(put.status, 204, '204 no content');

      const onDisk = readFileSync(join(root, 'topics/alpha.md'), 'utf8');
      t.ok(onDisk.includes('created: 2026-04-01'), 'created preserved from disk, not request');
      t.notOk(onDisk.includes('2099-01-01'), 'request created/updated discarded');
      const today = new Date().toISOString().slice(0, 10);
      t.ok(onDisk.includes(`updated: ${today}`), 'updated stamped to today');
      t.ok(onDisk.includes('Round-trip body.'), 'body replaced');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /sections/{id} syncs tags from frontmatter', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      ctx.db.exec(`
        INSERT INTO tags_taxonomy (tag, description, added) VALUES
          ('research', null, '2026-04-29'),
          ('design', null, '2026-04-29');
      `);

      const id = await findId(ctx.url, 'topics/alpha.md');
      const newMd = ['---', 'title: Alpha', 'tags: [research, design]', '---', 'body', ''].join('\n');
      const put = await fetchAuthed(`${ctx.url}/sections/${id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: newMd
      });
      t.equal(put.status, 204, '204 no content');

      const rows = ctx.db
        .prepare('SELECT tag FROM tags WHERE record_id = ? ORDER BY tag')
        .all(id) as Array<{tag: string}>;
      t.deepEqual(rows.map(r => r.tag), ['design', 'research'], 'tags synced from PUT body frontmatter');
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
