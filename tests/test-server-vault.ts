import test from 'tape-six';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-vault';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setupVault = (): {root: string; cleanup: () => void} => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-vault-test-'));
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
): Promise<{status: number; body: unknown; raw: string; contentType: string | null}> => {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${TEST_TOKEN}`);
  const res = await fetch(url, {...init, headers});
  const raw = await res.text();
  const ct = res.headers.get('content-type');
  let body: unknown = null;
  if (raw.length > 0) {
    if (ct?.includes('application/json')) body = JSON.parse(raw);
    else body = raw;
  }
  return {status: res.status, body, raw, contentType: ct};
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
      '---',
      'Alpha topic body.',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'topics/beta.md',
    ['---', 'title: Beta', 'created: 2026-04-10', 'updated: 2026-04-20', '---', 'Beta body.', ''].join(
      '\n'
    )
  );
  writeMd(
    root,
    'projects/demo/queue/item-one.md',
    [
      '---',
      'title: Item one',
      'type: queue-item',
      'created: 2026-04-22',
      'updated: 2026-04-22',
      'sequence_key: 1',
      '---',
      'First item body.',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'projects/demo/queue/item-two.md',
    [
      '---',
      'title: Item two',
      'type: queue-item',
      'created: 2026-04-22',
      'updated: 2026-04-22',
      'sequence_key: 2',
      '---',
      'Second item body.',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'projects/demo/queue/_about.md',
    ['---', 'title: Demo queue', 'type: meta', '---', 'Folder description.', ''].join('\n')
  );
};

test('GET /vault/{path} returns markdown content', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`);
      t.equal(r.status, 200, '200 ok');
      t.ok(r.contentType?.startsWith('text/markdown'), 'Content-Type is text/markdown');
      t.ok((r.body as string).includes('Alpha topic body.'), 'body contains seeded content');
      t.ok((r.body as string).includes('title: Alpha'), 'frontmatter included');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /vault/{unknown.md} returns 404', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/vault/topics/nope.md`);
      t.equal(r.status, 404, '404 not found');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /vault/{path}/ returns Obsidian-shaped folder list', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/vault/topics/`);
      t.equal(r.status, 200, '200 ok');
      const env = r.body as {files: string[]};
      t.deepEqual(env.files, ['alpha.md', 'beta.md'], 'lists topic markdown files');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /vault/ lists the root folder', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/vault/`);
      t.equal(r.status, 200, '200 ok');
      const env = r.body as {files: string[]};
      t.ok(env.files.includes('topics/'), 'root contains topics/');
      t.ok(env.files.includes('projects/'), 'root contains projects/');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /vault/{nested}/ marks subdirectories with trailing slash', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/vault/projects/demo/`);
      t.equal(r.status, 200, '200 ok');
      const env = r.body as {files: string[]};
      t.deepEqual(env.files, ['queue/'], 'subdir listed with trailing slash');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /vault/{path}/ returns 404 for missing folder', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/vault/no-such-folder/`);
      t.equal(r.status, 404, '404 not found');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /vault/{atomized.md} composes the folder back into one file', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      // No projects/demo/queue.md exists; queue/ is the atomized folder.
      const r = await fetchAuthed(`${ctx.url}/vault/projects/demo/queue.md`);
      t.equal(r.status, 200, '200 ok');
      const md = r.body as string;
      t.ok(md.includes('title: Demo queue'), 'composed frontmatter from _about');
      t.ok(md.includes('## Item one'), 'piece 1 heading');
      t.ok(md.includes('First item body.'), 'piece 1 body');
      t.ok(md.includes('## Item two'), 'piece 2 heading');
      t.ok(md.includes('Second item body.'), 'piece 2 body');
      t.ok(
        md.indexOf('Item one') < md.indexOf('Item two'),
        'pieces ordered by sequence_key'
      );
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path} creates a new file', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const md = ['---', 'title: New', 'tags: []', '---', 'New body content.', ''].join('\n');
      const put = await fetchAuthed(`${ctx.url}/vault/topics/created.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: md
      });
      t.equal(put.status, 204, '204 no content');

      const onDisk = readFileSync(join(root, 'topics/created.md'), 'utf8');
      t.ok(onDisk.includes('title: New'), 'title written to disk');
      t.ok(onDisk.includes('created: '), 'created stamped on first write');
      t.ok(onDisk.includes('updated: '), 'updated stamped');
      t.ok(onDisk.includes('New body content.'), 'body written');

      const list = await fetchAuthed(
        `${ctx.url}/sections?file_path=${encodeURIComponent('topics/created.md')}`
      );
      const envelope = list.body as {items: Array<{title: string}>};
      t.equal(envelope.items.length, 1, 'record indexed');
      t.equal(envelope.items[0]!.title, 'New', 'title indexed');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path} replaces an existing file and preserves created', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const md = ['---', 'title: Alpha v2', '---', 'Replaced body.', ''].join('\n');
      const put = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: md
      });
      t.equal(put.status, 204, '204 no content');

      const onDisk = readFileSync(join(root, 'topics/alpha.md'), 'utf8');
      t.ok(onDisk.includes('title: Alpha v2'), 'title updated');
      t.ok(onDisk.includes('created: 2026-04-01'), 'created preserved from existing fm');
      t.ok(onDisk.includes('Replaced body.'), 'body replaced');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path} syncs tags from frontmatter', async t => {
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

      const md = ['---', 'title: Alpha v3', 'tags: [research, design]', '---', 'replaced body', ''].join('\n');
      const put = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: md
      });
      t.equal(put.status, 204, '204 no content');

      const list = await fetchAuthed(
        `${ctx.url}/sections?file_path=${encodeURIComponent('topics/alpha.md')}`
      );
      const id = (list.body as {items: Array<{record_id: string}>}).items[0]!.record_id;

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

test('PUT /vault/{path} rejects path traversal', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/vault/${encodeURIComponent('../escape.md')}`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: 'evil'
      });
      t.equal(r.status, 400, '400 bad request');
      t.equal((r.body as {code: string}).code, 'invalid_path', 'code=invalid_path');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path} rejects non-md extensions', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/vault/topics/blob.bin`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: 'binary'
      });
      t.equal(r.status, 400, '400 bad request');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path} rejects DB-only frontmatter keys', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const md = ['---', "content_hash: 'deadbeef'", '---', 'body', ''].join('\n');
      const r = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: md
      });
      t.equal(r.status, 400, '400 bad request');
      t.equal((r.body as {code: string}).code, 'frontmatter_auto_managed', 'auto_managed code');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path} accepts created/updated round-trip; indexer overrides', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const md = [
        '---',
        'title: Alpha',
        "created: '2099-01-01'",
        "updated: '2099-01-01'",
        '---',
        'Round-trip body.',
        ''
      ].join('\n');
      const r = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: md
      });
      t.equal(r.status, 204, '204 no content');

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

test('DELETE /vault/{path} removes file and DB row', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const del = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`, {method: 'DELETE'});
      t.equal(del.status, 204, '204 no content');
      t.equal(existsSync(join(root, 'topics/alpha.md')), false, 'file removed');

      const list = await fetchAuthed(
        `${ctx.url}/sections?file_path=${encodeURIComponent('topics/alpha.md')}`
      );
      const envelope = list.body as {items: unknown[]; total: number};
      t.equal(envelope.total, 0, 'record deleted from DB');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('DELETE /vault/{unknown} returns 404', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/vault/topics/nope.md`, {method: 'DELETE'});
      t.equal(r.status, 404, '404 not found');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /vault/topics/alpha.md without auth returns 401', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const res = await fetch(`${ctx.url}/vault/topics/alpha.md`);
      t.equal(res.status, 401, '401 unauthorized');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});
