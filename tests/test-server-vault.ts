import test from 'tape-six';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {parseFrontmatter} from '../src/markdown/frontmatter.ts';
import {importVault} from '../src/importer/import.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';
import {contentHash} from '../src/util/hash.ts';

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

const fetchAuthed = async (
  url: string,
  init: RequestInit = {}
): Promise<{
  status: number;
  body: unknown;
  raw: string;
  contentType: string | null;
  etag: string | null;
  composed: string | null;
}> => {
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
  return {
    status: res.status,
    body,
    raw,
    contentType: ct,
    etag: res.headers.get('etag'),
    composed: res.headers.get('x-vault-composed')
  };
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
    [
      '---',
      'title: Beta',
      'created: 2026-04-10',
      'updated: 2026-04-20',
      '---',
      'Beta body.',
      ''
    ].join('\n')
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
      t.ok(md.indexOf('Item one') < md.indexOf('Item two'), 'pieces ordered by sequence_key');
      t.ok(r.etag?.startsWith('W/"'), 'composed response carries a weak ETag');
      t.equal(r.composed, 'true', 'composed response marked with X-Vault-Composed');

      const file = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`);
      t.ok(file.etag?.startsWith('"'), 'file response keeps a strong ETag');
      t.equal(file.composed, null, 'file response has no X-Vault-Composed');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{atomized.md} with If-Match 412s naming the composed folder', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const got = await fetchAuthed(`${ctx.url}/vault/projects/demo/queue.md`);
      const put = await fetchAuthed(`${ctx.url}/vault/projects/demo/queue.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json', 'If-Match': got.etag!},
        body: JSON.stringify({frontmatter: {title: 'Demo queue'}, body: 'flattened'})
      });
      t.equal(put.status, 412, 'conditional PUT against a composed view → 412');
      const err = put.body as {code: string; error: string; details: Record<string, unknown>};
      t.equal(err.code, 'precondition_failed', 'code');
      t.matchString(err.error, /composed on demand/, 'message names the real cause');
      t.match(err.details, {composed: true, folder: 'projects/demo/queue/'}, 'details');
      t.ok(!existsSync(join(root, 'projects/demo/queue.md')), 'nothing written');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{atomized.md} create 409s as shadow_conflict; ?shadow=allow overrides', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const payload = JSON.stringify({frontmatter: {title: 'Demo queue'}, body: 'flattened'});
      const put = await fetchAuthed(`${ctx.url}/vault/projects/demo/queue.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: payload
      });
      t.equal(put.status, 409, 'unconditional create over an atomized folder → 409');
      const err = put.body as {code: string; details: Record<string, unknown>};
      t.equal(err.code, 'shadow_conflict', 'code');
      t.match(err.details, {folder: 'projects/demo/queue/'}, 'details name the folder');
      t.ok(!existsSync(join(root, 'projects/demo/queue.md')), 'nothing written');

      const forced = await fetchAuthed(`${ctx.url}/vault/projects/demo/queue.md?shadow=allow`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: payload
      });
      t.equal(forced.status, 204, '?shadow=allow creates the file deliberately');
      t.ok(existsSync(join(root, 'projects/demo/queue.md')), 'file written');

      // The file now exists, so plain updates no longer trip the guard.
      const update = await fetchAuthed(`${ctx.url}/vault/projects/demo/queue.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: payload
      });
      t.equal(update.status, 204, 'update of an existing file next to the folder → 204');

      const got = await fetchAuthed(`${ctx.url}/vault/projects/demo/queue.md`);
      t.ok(got.etag?.startsWith('"'), 'shadowing file now serves with a strong ETag');
      t.equal(got.composed, null, 'no longer composed');
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

test('PUT /vault/{path} allows a delimiter-opening body when no stored frontmatter is at risk', async t => {
  // The unparsed-frontmatter guard fires only when the merge would resurrect
  // stored frontmatter. A brand-new path has none, so a body that opens with a
  // `---` thematic break (frontmatter parses empty) must still be accepted.
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const md = '---\n\nJust a horizontal rule then prose, no frontmatter.\n';
      const put = await fetchAuthed(`${ctx.url}/vault/topics/hr-opening.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: md
      });
      t.equal(put.status, 204, '204 no content — not rejected');
      const onDisk = readFileSync(join(root, 'topics/hr-opening.md'), 'utf8');
      t.ok(onDisk.includes('Just a horizontal rule'), 'body written to disk');
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

test('PUT /vault/{path} rejects serialized-null overwrites (null body / null frontmatter values)', async t => {
  // Guard for the 2026-06-18 wipe: a writer interpolating a missing value
  // overwrote a 59 KB note with the literal string "null". Removal is
  // DELETE, never a null write.
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const nullBody = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({frontmatter: {title: 'Alpha'}, body: 'null'})
      });
      t.equal(nullBody.status, 400, '400 on literal-"null" body');
      t.equal((nullBody.body as {code: string}).code, 'null_body', 'code=null_body');

      const nullFm = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({frontmatter: {title: 'Alpha', agent: null}, body: 'Real body.'})
      });
      t.equal(nullFm.status, 400, '400 on null frontmatter value');
      t.equal(
        (nullFm.body as {code: string}).code,
        'null_frontmatter_value',
        'code=null_frontmatter_value'
      );

      const mdNull = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: ['---', 'title: Alpha', '---', 'null', ''].join('\n')
      });
      t.equal(mdNull.status, 400, '400 on markdown-path literal-"null" body');
      t.equal((mdNull.body as {code: string}).code, 'null_body', 'markdown path shares the guard');

      const onDisk = readFileSync(join(root, 'topics/alpha.md'), 'utf8');
      t.ok(onDisk.includes('Alpha topic body.'), 'on-disk body untouched by all three');
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

      const md = [
        '---',
        'title: Alpha v3',
        'tags: [research, design]',
        '---',
        'replaced body',
        ''
      ].join('\n');
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
      t.deepEqual(
        rows.map(r => r.tag),
        ['design', 'research'],
        'tags synced from PUT body frontmatter'
      );
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path} normalizes curly-quoted tags into valid ids (iPad autocorrect)', async t => {
  // iOS autocorrect substitutes straight quotes with curly ones inside the FM
  // field, so `tags: ["blog"]` arrives with U+201C/U+201D baked into each value.
  // The writer must clean them at the source (markdown = source of truth), not
  // just in the derived index, so a re-read never re-parses the junk.
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      ctx.db.exec(`
        INSERT INTO tags_taxonomy (tag, description, added) VALUES
          ('blog', null, '2026-04-29'),
          ('bug', null, '2026-04-29');
      `);

      const md = [
        '---',
        'title: Alpha v4',
        'tags: [“blog”, “bug”, “blog”]',
        '---',
        'body',
        ''
      ].join('\n');
      const put = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: md
      });
      t.equal(put.status, 204, '204 no content');

      const onDisk = readFileSync(join(root, 'topics/alpha.md'), 'utf8');
      t.notOk(/[“”‘’]/.test(onDisk), 'no curly quotes survive in the stored markdown');
      t.ok(/tags:/.test(onDisk), 'tags key still present');

      const served = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`);
      const reparsed = parseFrontmatter(served.body as string).data as {tags: string[]};
      t.deepEqual(reparsed.tags, ['blog', 'bug'], 're-read yields clean, deduped tag ids');

      const list = await fetchAuthed(
        `${ctx.url}/sections?file_path=${encodeURIComponent('topics/alpha.md')}`
      );
      const id = (list.body as {items: Array<{record_id: string}>}).items[0]!.record_id;
      const rows = ctx.db
        .prepare('SELECT tag FROM tags WHERE record_id = ? ORDER BY tag')
        .all(id) as Array<{tag: string}>;
      t.deepEqual(
        rows.map(r => r.tag),
        ['blog', 'bug'],
        'index carries the clean tags too'
      );
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

test('PUT /vault/{path} returns 400 (not 500) on malformed YAML frontmatter', async t => {
  // Plain-scalar `: ` (colon-space) inside an unquoted multi-line value
  // makes YAML treat the second segment as a nested mapping key —
  // `yaml.parse` throws `YAMLParseError`. The writer used to let that
  // propagate as 500 internal; now caught and surfaced as a structured
  // 400 with the parser's diagnostic. Surfaced 2026-05-03 while writing
  // `topics/convenience-mount-subverts-multi-machine-design.md`.
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const md = [
        '---',
        'title: Bad YAML',
        'agent:',
        '  summary: The principle generalizes: any operator-visible',
        '    convenience that crosses a trust boundary creates a hidden coupling.',
        '---',
        'Body.',
        ''
      ].join('\n');
      const r = await fetchAuthed(`${ctx.url}/vault/raw/bad-yaml.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: md
      });
      t.equal(r.status, 400, '400 bad request, not 500 internal');
      const body = r.body as {code: string; error: string};
      t.equal(body.code, 'invalid_yaml', 'structured error code');
      t.ok(body.error.includes('invalid YAML'), 'error message names the cause');
      t.ok(
        body.error.includes('double quotes') || body.error.includes('folded block scalar'),
        'error message points at the workaround'
      );
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path} accepts double-quoted multi-line scalar with colon-space', async t => {
  // Companion to the malformed-YAML test above — the documented workaround
  // (double-quote the value) must round-trip cleanly.
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const md = [
        '---',
        'title: Quoted YAML',
        'agent:',
        '  summary: "The principle generalizes: any operator-visible convenience."',
        '---',
        'Body.',
        ''
      ].join('\n');
      const r = await fetchAuthed(`${ctx.url}/vault/raw/quoted-yaml.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: md
      });
      t.equal(r.status, 204, '204 no content — well-formed YAML accepted');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path} JSON: writes colon-space scalars without YAML quoting headache', async t => {
  // The motivating use case for the JSON mode — programmatic callers send
  // an FM object directly and never hit YAML parse rules. Strings that
  // would crash the YAML path (colon-space, leading `@`, bool/date shadow)
  // round-trip cleanly because the server picks the right YAML quoting on
  // the way to disk.
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const tricky = 'The principle generalizes: any operator-visible convenience.';
      const r = await fetchAuthed(`${ctx.url}/vault/raw/json-write.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          frontmatter: {
            title: 'JSON Write',
            agent: {summary: tricky},
            tags: ['design', '@user-leading-special']
          },
          body: 'Body content here.\n'
        })
      });
      t.equal(r.status, 204, '204 no content');

      const onDisk = readFileSync(join(root, 'raw/json-write.md'), 'utf8');
      t.ok(onDisk.startsWith('---\n'), 'opens with FM block');
      t.ok(onDisk.includes('title: JSON Write'), 'title round-tripped');
      t.ok(onDisk.includes('Body content here.'), 'body round-tripped');
      // Round-trip the on-disk FM via parseFrontmatter to confirm the saved
      // YAML is readable (not just visually present).
      const reparse = readFileSync(join(root, 'raw/json-write.md'), 'utf8');
      const reFm = (await import('../src/markdown/frontmatter.ts')).parseFrontmatter(reparse).data;
      const agent = reFm['agent'] as {summary?: unknown} | undefined;
      t.equal(agent?.summary, tricky, 'colon-space scalar survives YAML round-trip');
      const tags = reFm['tags'] as string[] | undefined;
      t.deepEqual(
        tags,
        ['design', 'user-leading-special'],
        'tags are normalized to valid ids at write (leading `@` stripped, matching the index)'
      );
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path} JSON: 400 on malformed JSON body', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/vault/raw/bad-json.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: '{not valid json'
      });
      t.equal(r.status, 400);
      t.equal((r.body as {code: string}).code, 'invalid_json');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path} JSON: 400 on wrong shape (missing fields, wrong types)', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      // Missing `body`.
      const r1 = await fetchAuthed(`${ctx.url}/vault/raw/missing-body.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({frontmatter: {title: 'x'}})
      });
      t.equal(r1.status, 400);
      t.equal((r1.body as {code: string}).code, 'invalid_json_shape');

      // FM not an object.
      const r2 = await fetchAuthed(`${ctx.url}/vault/raw/wrong-fm.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({frontmatter: 'not an object', body: 'x'})
      });
      t.equal(r2.status, 400);
      t.equal((r2.body as {code: string}).code, 'invalid_json_shape');

      // FM is an array (objects are validated, arrays are rejected).
      const r3 = await fetchAuthed(`${ctx.url}/vault/raw/array-fm.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({frontmatter: ['nope'], body: 'x'})
      });
      t.equal(r3.status, 400);
      t.equal((r3.body as {code: string}).code, 'invalid_json_shape');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path} JSON: same enum + auto-managed-key validation as markdown path', async t => {
  // The JSON path delegates to the same downstream validation as the
  // markdown path, so the existing closed-enum rules apply unchanged.
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      // Auto-managed key still rejected.
      const r1 = await fetchAuthed(`${ctx.url}/vault/raw/auto-managed.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          frontmatter: {title: 'X', content_hash: 'deadbeef'},
          body: 'x'
        })
      });
      t.equal(r1.status, 400);
      t.equal((r1.body as {code: string}).code, 'frontmatter_auto_managed');

      // Unknown enum still rejected.
      const r2 = await fetchAuthed(`${ctx.url}/vault/raw/bad-enum.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          frontmatter: {title: 'X', status: 'totally-bogus'},
          body: 'x'
        })
      });
      t.equal(r2.status, 400);
      t.equal((r2.body as {code: string}).code, 'invalid_enum_value');
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

test('POST /vault/move renames file + preserves record_id', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const before = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`);
      t.equal(before.status, 200, 'source readable before move');

      const beforeRow = ctx.db
        .prepare('SELECT record_id FROM records WHERE file_path = ?')
        .get('topics/alpha.md') as {record_id: string} | undefined;
      t.ok(beforeRow?.record_id, 'record exists at source path');
      const recordIdBefore = beforeRow!.record_id;

      const r = await fetchAuthed(`${ctx.url}/vault/move`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({from: 'topics/alpha.md', to: 'topics/archive/2026/alpha.md'})
      });
      t.equal(r.status, 204, '204 no content');

      // File moved on disk
      t.equal(existsSync(join(root, 'topics/alpha.md')), false, 'source file gone');
      t.equal(
        existsSync(join(root, 'topics/archive/2026/alpha.md')),
        true,
        'destination file present'
      );

      // Same record_id on the new path
      const afterRow = ctx.db
        .prepare('SELECT record_id FROM records WHERE file_path = ?')
        .get('topics/archive/2026/alpha.md') as {record_id: string} | undefined;
      t.equal(afterRow?.record_id, recordIdBefore, 'record_id preserved across move');

      // Old path no longer in DB
      const oldRow = ctx.db
        .prepare('SELECT record_id FROM records WHERE file_path = ?')
        .get('topics/alpha.md') as {record_id: string} | undefined;
      t.equal(oldRow, undefined, 'old path removed from records');

      // Read at new path works
      const after = await fetchAuthed(`${ctx.url}/vault/topics/archive/2026/alpha.md`);
      t.equal(after.status, 200, 'destination readable');
      t.equal(after.raw, before.raw, 'body byte-identical after move');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /vault/move 404 on missing source', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/vault/move`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({from: 'topics/nope.md', to: 'topics/archive/nope.md'})
      });
      t.equal(r.status, 404, '404 not found');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /vault/move 409 when destination exists', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/vault/move`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({from: 'topics/alpha.md', to: 'topics/beta.md'})
      });
      t.equal(r.status, 409, '409 conflict');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /vault/move 400 on invalid paths', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      // Non-md extension
      const r1 = await fetchAuthed(`${ctx.url}/vault/move`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({from: 'topics/alpha.txt', to: 'topics/archive/alpha.txt'})
      });
      t.equal(r1.status, 400, 'non-md extension rejected');

      // Identical paths
      const r2 = await fetchAuthed(`${ctx.url}/vault/move`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({from: 'topics/alpha.md', to: 'topics/alpha.md'})
      });
      t.equal(r2.status, 400, 'identical paths rejected');

      // Missing fields
      const r3 = await fetchAuthed(`${ctx.url}/vault/move`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({from: 'topics/alpha.md'})
      });
      t.equal(r3.status, 400, 'missing `to` rejected');

      // Invalid JSON
      const r4 = await fetchAuthed(`${ctx.url}/vault/move`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: 'not json'
      });
      t.equal(r4.status, 400, 'invalid JSON rejected');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /vault/move preserves edges keyed on record_id', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    // Add a wikilink in alpha → beta to create an edge.
    writeMd(
      root,
      'topics/alpha.md',
      `---
title: Alpha
type: permanent
status: active
created: 2026-04-01
updated: 2026-04-01
---
Alpha references [[topics/beta]].
`
    );
    const ctx = await startTestServer(root);
    try {
      // Edge count before move
      const edgesBefore = ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM edges
            WHERE from_id = (SELECT record_id FROM records WHERE file_path = ?)`
        )
        .get('topics/alpha.md') as {n: number};
      t.ok(edgesBefore.n >= 1, 'at least one outbound edge before move');

      // Move alpha to archive
      const r = await fetchAuthed(`${ctx.url}/vault/move`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({from: 'topics/alpha.md', to: 'topics/archive/2026/alpha.md'})
      });
      t.equal(r.status, 204, 'move ok');

      // Edge count after move — edges reference record_id, which we preserved
      const edgesAfter = ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM edges
            WHERE from_id = (SELECT record_id FROM records WHERE file_path = ?)`
        )
        .get('topics/archive/2026/alpha.md') as {n: number};
      t.equal(edgesAfter.n, edgesBefore.n, 'outbound edge count unchanged after move');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

// --- POST /vault/propose -------------------------------------------------

const PROPOSE_LONG_BODY =
  'A vector store backed by sqlite-vec stores normalized chunk embeddings. ' +
  'The chunker splits markdown bodies on header boundaries with a soft ' +
  'character cap. Doc-level mean-pool prefilters the chunk-level scan to ' +
  'keep latency bounded on large vaults. Repeat the substance several ' +
  'sentences to cross the 200-char minBodyLength gate that find-duplicates ' +
  'imposes on its scan side; propose itself has no minimum, but seeding ' +
  'the test corpus through importVault and embedPending demands real bodies ' +
  'large enough to chunk meaningfully.';

const PROPOSE_DISTANT_BODY =
  'Completely unrelated content about gardening, the cultivation of tomatoes ' +
  'in raised beds, mulch composition, drip irrigation tubing diameter ' +
  'tradeoffs, and how to detect early signs of late-blight infection on ' +
  'leaves before the spores spread to neighbouring plants. Nothing here ' +
  'overlaps the vector-store body conceptually or lexically; deterministic ' +
  'embedder will produce a wildly different vector.';

const seedForPropose = async (ctx: ServerCtx, root: string): Promise<void> => {
  // Seed a record via PUT, which runs through the writer + indexer +
  // embed-pending pathway end-to-end. Avoids a second separate code path
  // for fixturing.
  const headers = {Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json'};
  const written = await fetch(`${ctx.url}/vault/topics/vector-store.md`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      frontmatter: {title: 'Vector store', tags: [], type: 'permanent'},
      body: PROPOSE_LONG_BODY
    })
  });
  if (written.status !== 204) {
    throw new Error(`seed PUT failed: ${written.status} ${await written.text()}`);
  }
  // Run embed-pending so propose has chunks + doc-vec to scan against.
  const embedRes = await fetch(`${ctx.url}/maintenance/embed-pending`, {
    method: 'POST',
    headers
  });
  if (embedRes.status !== 200) {
    throw new Error(`embed-pending failed: ${embedRes.status}`);
  }
  void root;
};

test('POST /vault/propose returns top-K nearest with distance + summary', async t => {
  const {root, cleanup} = setupVault();
  try {
    const ctx = await startTestServer(root);
    try {
      await seedForPropose(ctx, root);

      const r = await fetchAuthed(`${ctx.url}/vault/propose`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({body: PROPOSE_LONG_BODY})
      });
      t.equal(r.status, 200, '200 ok');
      const body = r.body as {
        candidates: {record_id: string; file_path: string; distance: number}[];
        proposed_chunks: number;
      };
      t.ok(body.candidates.length >= 1, 'at least one candidate');
      const self = body.candidates.find(c => c.file_path === 'topics/vector-store.md');
      t.ok(self !== undefined, 'identical body matches the seeded record');
      t.ok(self !== undefined && self.distance < 1e-6, 'distance ≈ 0 on identical body');
      t.ok(body.proposed_chunks >= 1, 'reports chunk count');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /vault/propose distant body returns no near matches', async t => {
  const {root, cleanup} = setupVault();
  try {
    const ctx = await startTestServer(root);
    try {
      await seedForPropose(ctx, root);

      const r = await fetchAuthed(`${ctx.url}/vault/propose`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({body: PROPOSE_DISTANT_BODY})
      });
      t.equal(r.status, 200, '200 ok');
      const body = r.body as {candidates: {distance: number}[]};
      // Defaults: prefilter L2 ceiling 0.5 — for L2-normalized vectors this
      // corresponds to a tight cosine bound. A truly orthogonal random
      // FakeEmbedder vector will fail the prefilter; the candidate list
      // should be empty or contain only items above any reasonable
      // duplicate threshold.
      const tooClose = body.candidates.filter(c => c.distance < 0.5);
      t.equal(tooClose.length, 0, 'no candidates within near-match band');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /vault/propose with path excludes the existing record at that path', async t => {
  const {root, cleanup} = setupVault();
  try {
    const ctx = await startTestServer(root);
    try {
      await seedForPropose(ctx, root);

      const r = await fetchAuthed(`${ctx.url}/vault/propose`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({body: PROPOSE_LONG_BODY, path: 'topics/vector-store.md'})
      });
      t.equal(r.status, 200, '200 ok');
      const body = r.body as {candidates: {file_path: string}[]};
      const self = body.candidates.find(c => c.file_path === 'topics/vector-store.md');
      t.equal(self, undefined, 'self-record excluded when path is supplied');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /vault/propose 400 on missing body field', async t => {
  const {root, cleanup} = setupVault();
  try {
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/vault/propose`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({})
      });
      t.equal(r.status, 400, '400 bad request');
      t.equal((r.body as {code: string}).code, 'bad_request', 'bad_request code');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /vault/propose 400 on invalid JSON', async t => {
  const {root, cleanup} = setupVault();
  try {
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/vault/propose`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: 'not json'
      });
      t.equal(r.status, 400, '400 bad request');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /vault/propose 400 on empty body', async t => {
  const {root, cleanup} = setupVault();
  try {
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/vault/propose`, {method: 'POST'});
      t.equal(r.status, 400, '400 bad request');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

// --- PUT /vault/{path}?check=true ---------------------------------------

test('PUT /vault/{path}?check=true blocks naked write near a seeded record', async t => {
  const {root, cleanup} = setupVault();
  try {
    const ctx = await startTestServer(root);
    try {
      await seedForPropose(ctx, root);

      // Try to write the IDENTICAL body to a NEW path with check enabled.
      // The exclude-by-path logic doesn't fire (the new path has no record
      // yet), so the existing seeded record is the prime candidate at
      // distance ≈ 0.
      const r = await fetchAuthed(`${ctx.url}/vault/topics/vector-store-2.md?check=true`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          frontmatter: {title: 'Vector store 2', tags: [], type: 'permanent'},
          body: PROPOSE_LONG_BODY
        })
      });
      t.equal(r.status, 409, '409 conflict');
      const body = r.body as {
        code: string;
        candidates: {file_path: string; distance: number}[];
        threshold: number;
      };
      t.equal(body.code, 'dedup_conflict', 'dedup_conflict code');
      t.equal(body.threshold, 0.1, 'default threshold 0.1');
      t.ok(body.candidates.length >= 1, 'candidates present');
      t.equal(body.candidates[0]?.file_path, 'topics/vector-store.md', 'seeded record cited');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path} without ?check=true bypasses dedup gate', async t => {
  const {root, cleanup} = setupVault();
  try {
    const ctx = await startTestServer(root);
    try {
      await seedForPropose(ctx, root);

      // No ?check=true — naked PUT, default contract preserved. Same body
      // as the seeded record but writes go through.
      const r = await fetchAuthed(`${ctx.url}/vault/topics/vector-store-2.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          frontmatter: {title: 'Vector store 2', tags: [], type: 'permanent'},
          body: PROPOSE_LONG_BODY
        })
      });
      t.equal(r.status, 204, '204 ok — write succeeded');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path}?check=true with X-Vault-Dedup: skip header bypasses gate', async t => {
  const {root, cleanup} = setupVault();
  try {
    const ctx = await startTestServer(root);
    try {
      await seedForPropose(ctx, root);

      // ?check=true would normally 409 here, but the header opts the
      // caller out (e.g., they already ran propose explicitly).
      const r = await fetchAuthed(`${ctx.url}/vault/topics/vector-store-2.md?check=true`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json', 'X-Vault-Dedup': 'skip'},
        body: JSON.stringify({
          frontmatter: {title: 'Vector store 2', tags: [], type: 'permanent'},
          body: PROPOSE_LONG_BODY
        })
      });
      t.equal(r.status, 204, '204 ok — header bypassed the check');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path}?check=true distant body proceeds normally', async t => {
  const {root, cleanup} = setupVault();
  try {
    const ctx = await startTestServer(root);
    try {
      await seedForPropose(ctx, root);

      const r = await fetchAuthed(`${ctx.url}/vault/topics/gardening.md?check=true`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          frontmatter: {title: 'Gardening', tags: [], type: 'permanent'},
          body: PROPOSE_DISTANT_BODY
        })
      });
      t.equal(r.status, 204, '204 ok — distant content not blocked');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path}?check=true on update with same body is allowed (self-exclusion)', async t => {
  const {root, cleanup} = setupVault();
  try {
    const ctx = await startTestServer(root);
    try {
      await seedForPropose(ctx, root);

      // Re-PUT the seeded record. Without self-exclusion this would 409
      // against itself; the exclude-by-path logic must fire here.
      const r = await fetchAuthed(`${ctx.url}/vault/topics/vector-store.md?check=true`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          frontmatter: {title: 'Vector store', tags: [], type: 'permanent'},
          body: PROPOSE_LONG_BODY
        })
      });
      t.equal(r.status, 204, '204 ok — self-update not blocked');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path}?check=true&check_threshold=0 allows any body', async t => {
  const {root, cleanup} = setupVault();
  try {
    const ctx = await startTestServer(root);
    try {
      await seedForPropose(ctx, root);

      // Threshold 0 — only an exact-distance-0 hit blocks. Identical body
      // should still 409 (distance is essentially 0 from itself).
      const exact = await fetchAuthed(
        `${ctx.url}/vault/topics/vector-store-2.md?check=true&check_threshold=0`,
        {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            frontmatter: {title: 'Dup', tags: [], type: 'permanent'},
            body: PROPOSE_LONG_BODY
          })
        }
      );
      t.equal(exact.status, 409, 'exact match still blocks at threshold=0');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path}?check=true returns 400 (not 500) on malformed YAML frontmatter', async t => {
  const {root, cleanup} = setupVault();
  try {
    const ctx = await startTestServer(root);
    try {
      // Unquoted colon-space plain scalar — invalid YAML. Before the guard
      // this threw past the handler as a 500 when ?check=true was armed
      // (the dedup gate parses FM before the writer's guarded parse runs).
      const r = await fetchAuthed(`${ctx.url}/vault/topics/bad-yaml-check.md?check=true`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown'},
        body: '---\ntitle: Bad\nsummary: first: second\n  trailing line\n---\nBody.\n'
      });
      t.equal(r.status, 400, '400 bad request');
      const body = r.body as {code: string; error: string};
      t.equal(body.code, 'invalid_yaml', 'code=invalid_yaml');
      t.ok(body.error.includes('application/json'), 'error message points at the JSON path');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path}?check=true 400 on invalid threshold', async t => {
  const {root, cleanup} = setupVault();
  try {
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(
        `${ctx.url}/vault/topics/x.md?check=true&check_threshold=not-a-number`,
        {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            frontmatter: {title: 'X', tags: [], type: 'permanent'},
            body: 'tiny body'
          })
        }
      );
      t.equal(r.status, 400, '400 bad request');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

// --- ETag / If-Match (optimistic concurrency) ------------------------------

test('GET /vault/{path} returns an ETag of the served document bytes', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`);
      t.equal(r.status, 200, '200 ok');
      t.equal(r.etag, `"${contentHash(r.raw)}"`, 'ETag = quoted sha256 of the served bytes');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path} If-Match round-trip: fresh tag writes, stale tag 412s with current_etag', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const got = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`);
      const firstEtag = got.etag!;
      t.ok(firstEtag, 'GET produced an ETag');

      // Conditional write with the fresh tag succeeds and returns the new tag.
      const put1 = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json', 'If-Match': firstEtag},
        body: JSON.stringify({frontmatter: {title: 'Alpha v2'}, body: 'Edited by A.\n'})
      });
      t.equal(put1.status, 204, 'fresh If-Match → 204');
      t.ok(put1.etag, 'PUT response carries the new ETag');
      t.notEqual(put1.etag, firstEtag, 'new ETag differs');

      // The PUT-returned ETag matches what a fresh GET serves.
      const reGet = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`);
      t.equal(reGet.etag, put1.etag, 'PUT ETag = subsequent GET ETag');

      // A second writer holding the original (now stale) tag is rejected.
      const put2 = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json', 'If-Match': firstEtag},
        body: JSON.stringify({frontmatter: {title: 'Alpha stale'}, body: 'Clobber attempt.\n'})
      });
      t.equal(put2.status, 412, 'stale If-Match → 412');
      const err = put2.body as {code: string; details: {current_etag: string}};
      t.equal(err.code, 'precondition_failed', 'code=precondition_failed');
      t.equal(`"${err.details.current_etag}"`, put1.etag, '412 carries the current ETag for retry');

      // The stale write did not land.
      const after = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`);
      t.ok((after.body as string).includes('Edited by A.'), 'winning write preserved');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path} If-Match variants: bare tag, wildcard, markdown form, create', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const got = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`);
      const bare = got.etag!.slice(1, -1); // strip quotes — callers may send the raw hash

      const putBare = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json', 'If-Match': bare},
        body: JSON.stringify({frontmatter: {title: 'Alpha'}, body: 'Bare-tag edit.\n'})
      });
      t.equal(putBare.status, 204, 'unquoted If-Match value accepted');

      // Wildcard matches any existing document...
      const putStar = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown', 'If-Match': '*'},
        body: '---\ntitle: Alpha\n---\nWildcard edit via markdown form.\n'
      });
      t.equal(putStar.status, 204, 'If-Match: * on existing file → 204 (markdown form too)');

      // ...but never a missing one: conditional writes cannot create.
      const putCreate = await fetchAuthed(`${ctx.url}/vault/topics/brand-new.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json', 'If-Match': '*'},
        body: JSON.stringify({frontmatter: {title: 'New'}, body: 'x\n'})
      });
      t.equal(putCreate.status, 412, 'If-Match on nonexistent path → 412');

      // Stale tag through the markdown form 412s the same way.
      const putStaleMd = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'text/markdown', 'If-Match': got.etag!},
        body: '---\ntitle: Alpha\n---\nStale markdown write.\n'
      });
      t.equal(putStaleMd.status, 412, 'stale If-Match on markdown form → 412');

      // No header → unconditional, the pre-existing contract; 204 + ETag.
      const putPlain = await fetchAuthed(`${ctx.url}/vault/topics/alpha.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({frontmatter: {title: 'Alpha'}, body: 'Unconditional.\n'})
      });
      t.equal(putPlain.status, 204, 'no If-Match → last-writer-wins preserved');
      t.ok(putPlain.etag, 'unconditional PUT still returns the new ETag');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('PUT /vault/{path} "__unset__" removes a key — the /vault ingest ready-flag shape', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const setup = await fetchAuthed(`${ctx.url}/vault/raw/inbox-note.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          frontmatter: {title: 'Inbox note', ready: true},
          body: 'Raw material.\n'
        })
      });
      t.equal(setup.status, 204, 'create with ready: true');

      // The ingest archival step: mark processed, remove the ready flag.
      const put = await fetchAuthed(`${ctx.url}/vault/raw/inbox-note.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          frontmatter: {ready: '__unset__', processed: true},
          body: 'Raw material.\n'
        })
      });
      t.equal(put.status, 204, '204 no content');
      const onDisk = readFileSync(join(root, 'raw/inbox-note.md'), 'utf8');
      t.notOk(onDisk.includes('ready:'), 'ready removed');
      t.ok(onDisk.includes('processed: true'), 'processed set in the same write');
      t.ok(onDisk.includes('title: Inbox note'), 'unmentioned keys survive');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /vault/edit — append collapses trailing whitespace, FM verbatim, updated stamped', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const res = await fetchAuthed(`${ctx.url}/vault/edit`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          path: 'topics/alpha.md',
          op: 'append',
          text: '## Addendum\n\nAppended text.\n'
        })
      });
      t.equal(res.status, 200, '200 with result');
      t.ok((res.body as {etag: string}).etag, 'new etag returned');

      const onDisk = readFileSync(join(root, 'topics/alpha.md'), 'utf8');
      t.ok(
        onDisk.includes('Alpha topic body.\n## Addendum\n\nAppended text.'),
        'fragment joined after a single newline'
      );
      t.ok(onDisk.includes('title: Alpha'), 'frontmatter preserved');
      t.ok(onDisk.includes('created: 2026-04-01'), 'created preserved');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /vault/edit — replace asserts: single hit works, miss and ambiguity are loud 409s', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const ok = await fetchAuthed(`${ctx.url}/vault/edit`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          path: 'topics/alpha.md',
          op: 'replace',
          from: 'Alpha topic body.',
          to: 'Rewritten body. $& $$ backref bait.'
        })
      });
      t.equal(ok.status, 200);
      t.equal((ok.body as {replaced: number}).replaced, 1, 'replaced count returned');
      const onDisk = readFileSync(join(root, 'topics/alpha.md'), 'utf8');
      t.ok(onDisk.includes('Rewritten body. $& $$ backref bait.'), '$-patterns land literally');

      const miss = await fetchAuthed(`${ctx.url}/vault/edit`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          path: 'topics/alpha.md',
          op: 'replace',
          from: 'no such text',
          to: 'x'
        })
      });
      t.equal(miss.status, 409, 'missing target → 409, not a silent no-op');
      t.equal((miss.body as {code: string}).code, 'replace_assert_failed');
      t.equal(
        (miss.body as {details: {occurrences: number}}).details.occurrences,
        0,
        'count carried'
      );

      const seedAmbiguous = await fetchAuthed(`${ctx.url}/vault/edit`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          path: 'topics/alpha.md',
          op: 'append',
          text: 'dupe token\ndupe token\n'
        })
      });
      t.equal(seedAmbiguous.status, 200);
      const ambiguous = await fetchAuthed(`${ctx.url}/vault/edit`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          path: 'topics/alpha.md',
          op: 'replace',
          from: 'dupe token',
          to: 'x'
        })
      });
      t.equal(ambiguous.status, 409, 'ambiguous without all → 409');
      t.equal(
        (ambiguous.body as {details: {occurrences: number}}).details.occurrences,
        2,
        'occurrence count named'
      );

      const all = await fetchAuthed(`${ctx.url}/vault/edit`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          path: 'topics/alpha.md',
          op: 'replace',
          from: 'dupe token',
          to: 'resolved token',
          all: true
        })
      });
      t.equal(all.status, 200);
      t.equal((all.body as {replaced: number}).replaced, 2, 'all replaces every occurrence');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /vault/edit — guards: 404 no-create, composed 409, null-wipe, validation', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    mkdirSync(join(root, 'topics/atom'), {recursive: true});
    writeFileSync(
      join(root, 'topics/atom/_about.md'),
      ['---', 'title: Atom', '---', 'About.', ''].join('\n')
    );
    const ctx = await startTestServer(root);
    try {
      const missing = await fetchAuthed(`${ctx.url}/vault/edit`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: 'topics/nope.md', op: 'append', text: 'x'})
      });
      t.equal(missing.status, 404, 'edit never creates');

      const composed = await fetchAuthed(`${ctx.url}/vault/edit`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: 'topics/atom.md', op: 'append', text: 'x'})
      });
      t.equal(composed.status, 409, 'composed view refused');
      t.equal((composed.body as {code: string}).code, 'composed_view');

      const nullWipe = await fetchAuthed(`${ctx.url}/vault/edit`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          path: 'topics/alpha.md',
          op: 'replace',
          from: 'Alpha topic body.',
          to: 'null'
        })
      });
      t.equal(nullWipe.status, 400, 'edit that produces a null body hits the wipe guard');
      t.equal((nullWipe.body as {code: string}).code, 'null_body');

      const badOp = await fetchAuthed(`${ctx.url}/vault/edit`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: 'topics/alpha.md', op: 'prepend', text: 'x'})
      });
      t.equal(badOp.status, 400, 'unknown op rejected');

      const traversal = await fetchAuthed(`${ctx.url}/vault/edit`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path: '../outside.md', op: 'append', text: 'x'})
      });
      t.equal(traversal.status, 400, 'path traversal rejected');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});
