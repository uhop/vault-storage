import test from 'tape-six';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-write-unknown-tags';

const TAXONOMY: [string, string | null][] = [
  ['survey', 'Notes that survey a field.'],
  ['competitive', 'Comparisons against competing products.'],
  ['analysis', null],
  ['market-research', 'Reading a market before building for it.']
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

const note = (title: string, tags: string) =>
  ['---', `title: ${title}`, 'type: permanent', `tags: [${tags}]`, '---', 'Body.', ''].join('\n');

const startCtx = async (): Promise<Ctx> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-unknown-tags-'));
  mkdirSync(join(root, 'topics'), {recursive: true});
  writeFileSync(join(root, 'topics/a.md'), note('A', 'survey, competitive'));
  writeFileSync(join(root, 'topics/b.md'), note('B', 'survey'));
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

const newTagFiled = (db: DatabaseSync, tag: string): number =>
  (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM suggestions
          WHERE kind = 'new_tag' AND json_extract(payload, '$.tag') = ?`
      )
      .get(tag) as {n: number}
  ).n;

const tagsOf = (db: DatabaseSync, path: string): string[] =>
  (
    db
      .prepare(
        `SELECT t.tag FROM tags t JOIN records r ON r.record_id = t.record_id
          WHERE r.file_path = ? ORDER BY t.tag`
      )
      .all(path) as {tag: string}[]
  ).map(r => r.tag);

test('PUT /vault/{path}: an unknown tag writes, files new_tag, and answers 200 with candidates', async t => {
  const ctx = await startCtx();
  try {
    const url = `${ctx.url}/vault/topics/new.md`;
    const r = await json(url, 'PUT', {
      frontmatter: {title: 'New', type: 'permanent', tags: ['survey', 'Competitor Survey']},
      body: 'Body.'
    });
    t.equal(r.status, 200, 'answered, not 204');
    t.ok(typeof r.body.etag === 'string' && r.body.etag.length > 0, 'the etag is in the body');
    t.equal(r.etag, `"${r.body.etag}"`, 'and in the ETag header');
    t.equal(r.body.unknown_tags.length, 1);
    const [unknown] = r.body.unknown_tags;
    t.equal(unknown.tag, 'Competitor Survey', 'as written');
    t.equal(unknown.resolved, 'competitor-survey', 'as the importer would store it');
    t.ok(unknown.nearest.length > 0 && unknown.nearest.length <= 5, 'up to five candidates');
    const survey = unknown.nearest.find((i: {tag: string}) => i.tag === 'survey');
    t.ok(survey?.matched.includes('name'), 'survey matched by a word of the name');
    const competitive = unknown.nearest.find((i: {tag: string}) => i.tag === 'competitive');
    t.ok(competitive?.matched.includes('alias'), 'competitive matched through its alias');
    t.ok(existsSync(join(ctx.root, 'topics/new.md')), 'the file was written');
    t.deepEqual(tagsOf(ctx.db, 'topics/new.md'), ['survey'], 'only the known tag is stored');
    t.equal(newTagFiled(ctx.db, 'competitor-survey'), 1, 'the importer filed its new_tag');

    const known = await json(url, 'PUT', {frontmatter: {tags: ['survey']}, body: 'Body.'});
    t.equal(known.status, 204, 'every tag known: 204 as before');
    t.ok(known.etag, 'with the ETag header');

    const bad = await json(url, 'PUT', {frontmatter: {}, body: 'Body.', strict_tags: 'yes'});
    t.equal(bad.status, 400);
    t.equal(bad.body.code, 'invalid_json_shape');
  } finally {
    await stopCtx(ctx);
  }
});

test('strict_tags refuses before writing and files nothing', async t => {
  const ctx = await startCtx();
  try {
    const url = `${ctx.url}/vault/topics/strict.md`;
    const r = await json(url, 'PUT', {
      frontmatter: {title: 'Strict', type: 'permanent', tags: ['survey', 'brand-new']},
      body: 'Body.',
      strict_tags: true
    });
    t.equal(r.status, 409);
    t.equal(r.body.code, 'unknown_tags');
    t.match(r.body.details.unknown[0], {tag: 'brand-new', resolved: 'brand-new'});
    t.ok(Array.isArray(r.body.details.unknown[0].nearest), 'candidates travel in details');
    t.notOk(existsSync(join(ctx.root, 'topics/strict.md')), 'nothing written');
    t.equal(newTagFiled(ctx.db, 'brand-new'), 0, 'nothing filed');

    const ok = await json(url, 'PUT', {
      frontmatter: {title: 'Strict', type: 'permanent', tags: ['survey', 'competitor']},
      body: 'Body.',
      strict_tags: true
    });
    t.equal(ok.status, 204, 'known tags and an alias pass under strict');
    t.deepEqual(tagsOf(ctx.db, 'topics/strict.md'), ['competitive', 'survey']);
  } finally {
    await stopCtx(ctx);
  }
});

test('markdown mode: an unknown tag in the block answers 200 too', async t => {
  const ctx = await startCtx();
  try {
    const r = await send(
      `${ctx.url}/vault/topics/md.md`,
      'PUT',
      note('Md', 'survey, fresh-tag'),
      'text/markdown'
    );
    t.equal(r.status, 200);
    t.equal(r.body.unknown_tags[0].resolved, 'fresh-tag');
    t.equal(newTagFiled(ctx.db, 'fresh-tag'), 1);
  } finally {
    await stopCtx(ctx);
  }
});

test('PUT /sections/{id}: the same answer and the same refusal', async t => {
  const ctx = await startCtx();
  try {
    const list = await json(`${ctx.url}/sections?file_prefix=topics/a.md`, 'GET');
    const id = list.body.items[0].record_id as string;
    const url = `${ctx.url}/sections/${id}`;
    const soft = await json(url, 'PUT', {
      frontmatter: {tags: ['survey', 'novel-thing']},
      body: 'Body.'
    });
    t.equal(soft.status, 200);
    t.equal(soft.body.unknown_tags[0].resolved, 'novel-thing');
    t.deepEqual(tagsOf(ctx.db, 'topics/a.md'), ['survey']);

    const strict = await json(url, 'PUT', {
      frontmatter: {tags: ['survey', 'another-new']},
      body: 'Changed.',
      strict_tags: true
    });
    t.equal(strict.status, 409);
    t.equal(strict.body.code, 'unknown_tags');
    t.deepEqual(tagsOf(ctx.db, 'topics/a.md'), ['survey'], 'the record is untouched');
    t.equal(newTagFiled(ctx.db, 'another-new'), 0);
  } finally {
    await stopCtx(ctx);
  }
});

test("POST /vault/supersede: the successor's tags get the same treatment", async t => {
  const ctx = await startCtx();
  try {
    const url = `${ctx.url}/vault/supersede`;
    const strict = await json(url, 'POST', {
      old_path: 'topics/a.md',
      frontmatter: {title: 'A2', type: 'permanent', tags: ['zzz-new']},
      body: 'A2.',
      strict_tags: true
    });
    t.equal(strict.status, 409);
    t.equal(strict.body.code, 'unknown_tags');
    t.ok(existsSync(join(ctx.root, 'topics/a.md')), 'the old note stays where it was');

    const soft = await json(url, 'POST', {
      old_path: 'topics/b.md',
      frontmatter: {title: 'B2', type: 'permanent', tags: ['survey', 'fresh-tag']},
      body: 'B2.'
    });
    t.equal(soft.status, 200);
    t.equal(soft.body.unknown_tags[0].resolved, 'fresh-tag');
    const year = new Date().getFullYear();
    t.ok(existsSync(join(ctx.root, `topics/archive/${year}/b.md`)), 'the old note is archived');
    t.equal(soft.body.new.path, 'topics/b.md');

    const badFlag = await json(url, 'POST', {
      old_path: 'topics/b.md',
      frontmatter: {title: 'B3'},
      body: 'B3.',
      strict_tags: 'no'
    });
    t.equal(badFlag.status, 400);
    t.equal(badFlag.body.code, 'invalid_json_shape');
  } finally {
    await stopCtx(ctx);
  }
});
