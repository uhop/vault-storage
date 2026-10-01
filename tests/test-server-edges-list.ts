import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import {EdgesRepository} from '../src/records/edges.ts';
import {RecordsRepository} from '../src/records/repository.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-edges-list';

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
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-edges-list-'));
  mkdirSync(join(root, 'topics'), {recursive: true});
  for (const n of ['a', 'b', 'c'])
    writeFileSync(join(root, `topics/${n}.md`), note(n.toUpperCase()));
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, root);
  const records = new RecordsRepository(db);
  const id = (path: string) => records.getByPath(path)!.recordId;
  const edges = new EdgesRepository(db);
  const edge = (
    from: string,
    to: string,
    type: string,
    created: string,
    note: string | null = null
  ) =>
    edges.upsert({
      fromId: id(from),
      toId: id(to),
      type: type as never,
      weight: 1,
      note,
      created
    });
  edge('topics/a.md', 'topics/b.md', 'cites', '2026-09-01T00:00:00.000Z');
  edge('topics/a.md', 'topics/c.md', 'derived-from', '2026-09-03T00:00:00.000Z', 'per the review');
  edge('topics/b.md', 'topics/c.md', 'related-to', '2026-09-02T00:00:00.000Z');
  edge('topics/c.md', 'topics/b.md', 'related-to', '2026-09-02T00:00:00.000Z');
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

const get = async (url: string): Promise<{status: number; body: any}> => {
  const res = await fetch(url, {headers: {Authorization: `Bearer ${TEST_TOKEN}`}});
  return {status: res.status, body: await res.json()};
};

test('GET /edges lists every edge newest first with both records, a mirrored pair once', async t => {
  const ctx = await startCtx();
  try {
    const r = await get(`${ctx.url}/edges`);
    t.equal(r.status, 200);
    t.equal(r.body.total, 3, 'four stored rows, the mirrored related-to pair counted once');
    t.deepEqual(
      r.body.items.map((e: {type: string}) => e.type),
      ['derived-from', 'related-to', 'cites'],
      'newest first'
    );
    t.match(r.body.items[0], {
      type: 'derived-from',
      note: 'per the review',
      from: {file_path: 'topics/a.md', title: 'A'},
      to: {file_path: 'topics/c.md', title: 'C'}
    });
    t.match(r.body.by_type, {cites: 1, 'derived-from': 1, 'related-to': 1, supersedes: 0});
    t.equal(Object.keys(r.body.by_type).length, 7, 'every type has a count');
    t.ok(typeof r.body.as_of?.generation === 'number');
  } finally {
    await stopCtx(ctx);
  }
});

test('GET /edges lists and counts a mirrored contradicts pair once', async t => {
  const ctx = await startCtx();
  try {
    const records = new RecordsRepository(ctx.db);
    const id = (path: string) => records.getByPath(path)!.recordId;
    const edges = new EdgesRepository(ctx.db);
    for (const [from, to] of [
      ['topics/a.md', 'topics/b.md'],
      ['topics/b.md', 'topics/a.md']
    ] as const)
      edges.upsert({
        fromId: id(from),
        toId: id(to),
        type: 'contradicts',
        weight: 1,
        note: null,
        created: '2026-09-04T00:00:00.000Z'
      });
    const r = await get(`${ctx.url}/edges?type=contradicts`);
    t.equal(r.body.total, 1, 'two stored rows, one listed');
    t.equal(r.body.items.length, 1);
    t.equal(r.body.by_type.contradicts, 1);
  } finally {
    await stopCtx(ctx);
  }
});

test('GET /edges filters by type, pages by the envelope, and refuses an unknown type', async t => {
  const ctx = await startCtx();
  try {
    const cites = await get(`${ctx.url}/edges?type=cites`);
    t.equal(cites.body.total, 1);
    t.equal(cites.body.items[0].type, 'cites');
    const two = await get(`${ctx.url}/edges?type=cites,related-to`);
    t.equal(two.body.total, 2, 'a CSV of types');
    t.match(two.body.by_type, {'derived-from': 1}, 'by_type counts the whole table regardless');

    const page = await get(`${ctx.url}/edges?limit=2`);
    t.equal(page.body.items.length, 2);
    t.equal(page.body.limit, 2);
    const next = await get(`${ctx.url}/edges?limit=2&offset=2`);
    t.equal(next.body.items.length, 1);
    t.equal(next.body.offset, 2);

    const bad = await get(`${ctx.url}/edges?type=friends`);
    t.equal(bad.status, 400);
    const unknownParam = await get(`${ctx.url}/edges?kind=cites`);
    t.equal(unknownParam.status, 400, 'an unknown query parameter is refused');
  } finally {
    await stopCtx(ctx);
  }
});
