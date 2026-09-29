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

const TEST_TOKEN = 'test-token-write-edges';

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

interface Ctx {
  root: string;
  db: DatabaseSync;
  handle: ServerHandle;
  url: string;
}

const note = (title: string) =>
  ['---', `title: ${title}`, 'type: permanent', '---', 'Body.', ''].join('\n');

const startCtx = async (): Promise<Ctx> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-write-edges-'));
  mkdirSync(join(root, 'topics'), {recursive: true});
  writeFileSync(join(root, 'topics/a.md'), note('A'));
  writeFileSync(join(root, 'topics/b.md'), note('B'));
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, root);
  const handle = await startServer({
    db,
    env: makeEnv(0, root),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {root, db, handle, url: `http://127.0.0.1:${port}`};
};

const stopCtx = async (ctx: Ctx): Promise<void> => {
  await ctx.handle.close();
  ctx.db.close();
  rmSync(ctx.root, {recursive: true, force: true});
};

interface Reply {
  status: number;
  etag: string | null;
  body: any;
}

const send = async (
  url: string,
  method: string,
  body: string | undefined,
  contentType: string
): Promise<Reply> => {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      ...(body !== undefined ? {'Content-Type': contentType} : {})
    },
    ...(body !== undefined ? {body} : {})
  });
  const text = await res.text();
  return {
    status: res.status,
    etag: res.headers.get('etag'),
    body: text.length === 0 ? null : JSON.parse(text)
  };
};

const json = (url: string, method: string, body?: unknown) =>
  send(url, method, body === undefined ? undefined : JSON.stringify(body), 'application/json');

const edgesOf = (db: DatabaseSync, path: string): Array<[string, string, string]> =>
  db
    .prepare(
      `SELECT f.file_path AS from_path, e.type, t.file_path AS to_path
         FROM edges e
         JOIN records f ON f.record_id = e.from_id
         JOIN records t ON t.record_id = e.to_id
        WHERE f.file_path = ? OR t.file_path = ?
        ORDER BY from_path, e.type, to_path`
    )
    .all(path, path)
    .map(r => {
      const row = r as {from_path: string; type: string; to_path: string};
      return [row.from_path, row.type, row.to_path];
    });

test('PUT /vault/{path}: a declared edges: entry stores the edge without a body link', async t => {
  const ctx = await startCtx();
  try {
    const r = await json(`${ctx.url}/vault/topics/c.md`, 'PUT', {
      frontmatter: {
        title: 'C',
        type: 'permanent',
        edges: {'topics/a': 'derived-from', b: 'basis-for'}
      },
      body: 'No wikilinks here.'
    });
    t.equal(r.status, 204, 'every target resolved: a plain 204');
    t.deepEqual(
      edgesOf(ctx.db, 'topics/c.md'),
      [
        ['topics/b.md', 'derived-from', 'topics/c.md'],
        ['topics/c.md', 'derived-from', 'topics/a.md']
      ],
      'the declared edge and the flipped alias are stored'
    );
  } finally {
    await stopCtx(ctx);
  }
});

test('PUT /vault/{path}: an unresolved target writes and answers 200 with unresolved_edges', async t => {
  const ctx = await startCtx();
  try {
    const r = await json(`${ctx.url}/vault/topics/c.md`, 'PUT', {
      frontmatter: {title: 'C', type: 'permanent', edges: {a: 'cites', 'topics/nope': 'revises'}},
      body: 'Body.'
    });
    t.equal(r.status, 200, 'answered, not 204');
    t.ok(typeof r.body.etag === 'string', 'the etag is in the body');
    t.deepEqual(
      r.body.unresolved_edges,
      [{target: 'topics/nope', type: 'revises'}],
      'the miss named'
    );
    t.notOk('unknown_tags' in r.body, 'no tags key when every tag was known');
    t.deepEqual(
      edgesOf(ctx.db, 'topics/c.md'),
      [['topics/c.md', 'cites', 'topics/a.md']],
      'the resolved edge stored'
    );
  } finally {
    await stopCtx(ctx);
  }
});

test('PUT /vault/{path}: strict_edges refuses an unresolved target with 409 and writes nothing', async t => {
  const ctx = await startCtx();
  try {
    const r = await json(`${ctx.url}/vault/topics/c.md`, 'PUT', {
      frontmatter: {title: 'C', type: 'permanent', edges: {'topics/nope': 'revises'}},
      body: 'Body.',
      strict_edges: true
    });
    t.equal(r.status, 409, '409');
    t.equal(r.body.code, 'unresolved_edges', 'named');
    t.deepEqual(r.body.details.unresolved, [{target: 'topics/nope', type: 'revises'}]);
    const gone = await send(`${ctx.url}/vault/topics/c.md`, 'GET', undefined, 'text/plain');
    t.equal(gone.status, 404, 'nothing written');
  } finally {
    await stopCtx(ctx);
  }
});

test("PUT /vault/{path}: a type outside the vocabulary stays the writer's 400", async t => {
  const ctx = await startCtx();
  try {
    const r = await json(`${ctx.url}/vault/topics/c.md`, 'PUT', {
      frontmatter: {title: 'C', type: 'permanent', edges: {a: 'clarifies'}},
      body: 'Body.'
    });
    t.equal(r.status, 400, '400');
    t.equal(r.body.code, 'invalid_enum_value', 'the writer refuses it, as before');
    t.ok(r.body.error.includes("edges value 'clarifies' for a"), 'naming value and target');
    t.ok(r.body.error.includes('basis-for'), 'listing the vocabulary, alias included');
    const shape = await json(`${ctx.url}/vault/topics/c.md`, 'PUT', {
      frontmatter: {title: 'C', type: 'permanent', edges: ['a']},
      body: 'Body.'
    });
    t.equal(shape.status, 400, 'a list is not a map');
    const bad = await json(`${ctx.url}/vault/topics/c.md`, 'PUT', {
      frontmatter: {title: 'C', type: 'permanent'},
      body: 'Body.',
      strict_edges: 'yes'
    });
    t.equal(bad.status, 400, 'strict_edges must be a boolean');
  } finally {
    await stopCtx(ctx);
  }
});

test('PUT /sections/{id}: the same checks on the record write', async t => {
  const ctx = await startCtx();
  try {
    const id = (
      ctx.db.prepare(`SELECT record_id FROM records WHERE file_path = 'topics/a.md'`).get() as {
        record_id: string;
      }
    ).record_id;
    const r = await json(`${ctx.url}/sections/${id}`, 'PUT', {
      frontmatter: {title: 'A', type: 'permanent', edges: {b: 'supersedes', nope: 'cites'}},
      body: 'Body.'
    });
    t.equal(r.status, 200, 'answered');
    t.deepEqual(r.body.unresolved_edges, [{target: 'nope', type: 'cites'}]);
    t.deepEqual(edgesOf(ctx.db, 'topics/a.md'), [['topics/a.md', 'supersedes', 'topics/b.md']]);
    const strict = await json(`${ctx.url}/sections/${id}`, 'PUT', {
      frontmatter: {title: 'A', type: 'permanent', edges: {nope: 'cites'}},
      body: 'Body.',
      strict_edges: true
    });
    t.equal(strict.status, 409, 'refused');
  } finally {
    await stopCtx(ctx);
  }
});
