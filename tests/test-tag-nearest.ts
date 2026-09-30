import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {embedTagsPending, tagEmbedText} from '../src/embeddings/embed-tags.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import type {Embedder} from '../src/embeddings/types.ts';
import {importVault} from '../src/importer/import.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-tag-nearest';

const SURVEY = 'Notes that survey a field: what exists, who made it, and how it compares.';

const TAXONOMY: [string, string | null][] = [
  ['survey', SURVEY],
  ['competitive', 'Comparisons against competing products.'],
  ['analysis', null],
  ['market-research', 'Reading a market before building for it.'],
  ['unrelated', 'Something else entirely.']
];

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

const startCtx = async (): Promise<Ctx> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-tag-nearest-'));
  mkdirSync(join(root, 'topics'), {recursive: true});
  writeFileSync(
    join(root, 'topics/a.md'),
    ['---', 'title: A', 'type: permanent', 'tags: [survey, competitive]', '---', 'Body.', ''].join(
      '\n'
    )
  );
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  const insert = db.prepare(
    "INSERT INTO tags_taxonomy (tag, description, added, origin) VALUES (?, ?, '2026-09-01', 'minted')"
  );
  for (const [tag, description] of TAXONOMY) insert.run(tag, description);
  db.prepare(
    "INSERT INTO tag_aliases (alias, canonical) VALUES ('competitor', 'competitive')"
  ).run();
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

const api = async (
  url: string,
  method: string,
  body?: unknown
): Promise<{status: number; body: any}> => {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      ...(body !== undefined ? {'Content-Type': 'application/json'} : {})
    },
    ...(body !== undefined ? {body: JSON.stringify(body)} : {})
  });
  const text = await res.text();
  return {status: res.status, body: text.length === 0 ? null : JSON.parse(text)};
};

const nearest = (ctx: Ctx, body: unknown) => api(`${ctx.url}/tags/nearest`, 'POST', body);

const count = (db: DatabaseSync, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {n: number}).n;

test('nearest: a malformed body or an unknown query parameter is a 400', async t => {
  const ctx = await startCtx();
  try {
    const bad: unknown[] = [
      {},
      {text: ''},
      {text: 3},
      {tags: []},
      {tags: ['a', 3]},
      {tags: 'a'},
      {tags: [' ']},
      {text: 'x', k: 0},
      {text: 'x', k: 51},
      {text: 'x', k: 1.5},
      {text: 'x', k: '3'}
    ];
    for (const body of bad) {
      const r = await nearest(ctx, body);
      t.equal(r.status, 400, `${JSON.stringify(body)} is refused`);
      t.equal(r.body.code, 'bad_request');
    }
    const q = await api(`${ctx.url}/tags/nearest?x=1`, 'POST', {text: 'x'});
    t.equal(q.status, 400, 'query parameters are refused');
  } finally {
    await stopCtx(ctx);
  }
});

test("nearest: a text identical to a tag's embedding text ranks it first; vectors embed once", async t => {
  const ctx = await startCtx();
  try {
    const first = await nearest(ctx, {text: tagEmbedText('survey', SURVEY), k: 3});
    t.equal(first.status, 200);
    t.deepEqual(first.body.tag_vecs, {embedded: 5, up_to_date: 0, total: 5}, 'every tag embedded');
    t.equal(count(ctx.db, 'tag_vec_meta'), 5);
    t.equal(count(ctx.db, 'tag_vec'), 5);
    t.equal(first.body.queries.length, 1);
    const [q] = first.body.queries;
    t.equal(q.kind, 'text');
    t.equal(q.exact, null, 'a text query has no exact form');
    t.equal(q.items.length, 3, 'k caps the list');
    t.match(q.items[0], {
      tag: 'survey',
      description: SURVEY,
      origin: 'minted',
      record_count: 1,
      score: 1,
      matched: ['embedding']
    });
    t.ok(typeof first.body.as_of?.generation === 'number', 'as_of is carried');

    const second = await nearest(ctx, {text: 'anything', k: 50});
    t.deepEqual(
      second.body.tag_vecs,
      {embedded: 0, up_to_date: 5, total: 5},
      'nothing re-embedded'
    );
    t.equal(second.body.queries[0].items.length, 5, 'k past the taxonomy size returns every tag');
  } finally {
    await stopCtx(ctx);
  }
});

test('nearest: a proposed name matches exactly, through an alias, and by its words', async t => {
  const ctx = await startCtx();
  try {
    const r = await nearest(ctx, {
      tags: ['Competitor Survey', 'survey', 'competitor', 'nothing-here'],
      k: 5
    });
    t.equal(r.status, 200);
    const [words, exact, alias, none] = r.body.queries;

    t.equal(words.kind, 'tag');
    t.equal(words.exact, null, 'competitor-survey is no tag');
    const survey = words.items.find((i: {tag: string}) => i.tag === 'survey');
    t.ok(survey.matched.includes('name'), 'survey matched by a word of the name');
    const competitive = words.items.find((i: {tag: string}) => i.tag === 'competitive');
    t.ok(competitive.matched.includes('alias'), 'competitive matched through its alias competitor');
    t.ok(
      words.items.every((i: {score: number | null}) => typeof i.score === 'number'),
      'every item carries a score from its stored vector'
    );

    t.deepEqual(exact.exact, {tag: 'survey'});
    t.equal(exact.items[0].tag, 'survey', 'the exact hit ranks first');
    t.ok(exact.items[0].matched.includes('exact'));

    t.deepEqual(alias.exact, {tag: 'competitive', requested: 'competitor'});
    t.equal(alias.items[0].tag, 'competitive');
    t.ok(alias.items[0].matched.includes('exact'), 'an exact alias hit is labelled exact');

    t.equal(none.exact, null);
    t.ok(
      none.items.every(
        (i: {matched: string[]}) => i.matched.length === 1 && i.matched[0] === 'embedding'
      ),
      'a name matching nothing gets embedding neighbours only'
    );
  } finally {
    await stopCtx(ctx);
  }
});

test("nearest: a re-described tag is re-embedded on the next call, and a deleted tag's vector goes", async t => {
  const ctx = await startCtx();
  try {
    await nearest(ctx, {text: 'warm', k: 1});
    const patched = await api(`${ctx.url}/tags/taxonomy/unrelated`, 'PATCH', {
      description: 'Now about something.'
    });
    t.equal(patched.status, 200);
    const after = await nearest(ctx, {text: 'warm', k: 1});
    t.deepEqual(after.body.tag_vecs, {embedded: 1, up_to_date: 4, total: 5}, 'one tag re-embedded');

    const deleted = await api(`${ctx.url}/tags/taxonomy/analysis`, 'DELETE');
    t.equal(deleted.status, 200);
    t.equal(count(ctx.db, 'tag_vec_meta'), 4, 'the trigger dropped the hash row');
    t.equal(count(ctx.db, 'tag_vec'), 4, 'and the vector');
    const gone = await nearest(ctx, {text: 'warm', k: 50});
    t.deepEqual(gone.body.tag_vecs, {embedded: 0, up_to_date: 4, total: 4});
    t.notOk(
      gone.body.queries[0].items.some((i: {tag: string}) => i.tag === 'analysis'),
      'a deleted tag is never returned'
    );
  } finally {
    await stopCtx(ctx);
  }
});

test('embed-pending refreshes the tag vectors after the records', async t => {
  const ctx = await startCtx();
  try {
    const r = await api(`${ctx.url}/maintenance/embed-pending`, 'POST');
    t.equal(r.status, 200);
    t.deepEqual(r.body.tag_vecs.embedded, 5);
    t.equal(r.body.tag_vecs.total, 5);
    t.ok(typeof r.body.embedded === 'number', 'the record summary is still there');
  } finally {
    await stopCtx(ctx);
  }
});

test('embedTagsPending: a tag deleted or re-described while its batch embeds gets no stale vector', async t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  try {
    db.exec(`INSERT INTO tags_taxonomy (tag, description, added) VALUES
      ('gone', 'Deleted mid-pass.', '2026-09-30'),
      ('moved', 'Before.', '2026-09-30'),
      ('kept', 'Stands still.', '2026-09-30')`);
    const fake = new FakeEmbedder();
    let beforeBatch = (): void => {
      beforeBatch = () => {};
      db.exec(`DELETE FROM tags_taxonomy WHERE tag = 'gone'`);
      db.exec(`UPDATE tags_taxonomy SET description = 'After.' WHERE tag = 'moved'`);
    };
    const embedder: Embedder = {
      dim: fake.dim,
      modelName: fake.modelName,
      retained: false,
      embed: text => fake.embed(text),
      embedQuery: text => fake.embedQuery(text),
      embedBatch: async texts => {
        beforeBatch();
        return fake.embedBatch(texts);
      },
      releaseRetained: async () => {}
    };
    const stored = (): string[] =>
      (db.prepare('SELECT tag FROM tag_vec_meta ORDER BY tag').all() as {tag: string}[]).map(
        r => r.tag
      );

    const first = await embedTagsPending(db, embedder);
    t.equal(first.embedded, 1, 'only the tag that stood still is embedded');
    t.deepEqual(stored(), ['kept'], 'no vector for the deleted tag or the old description');
    t.equal(count(db, 'tag_vec'), 1);

    const second = await embedTagsPending(db, embedder);
    t.equal(second.embedded, 1, 'the next pass embeds the re-described tag');
    t.deepEqual(stored(), ['kept', 'moved']);
  } finally {
    db.close();
  }
});
