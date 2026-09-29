import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {tagEmbedText} from '../src/embeddings/embed-tags.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-tag-create-preview';

const SURVEY_DESC = 'Notes that survey a field.';
const FIELD_DESC = 'A walk through one field of work, naming what exists in it.';

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

const note = (title: string, tags: string, summary: string) =>
  [
    '---',
    `title: ${title}`,
    'type: permanent',
    `tags: [${tags}]`,
    'agent:',
    `  summary: "${summary}"`,
    '---',
    'Body.',
    ''
  ].join('\n');

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

const startCtx = async (): Promise<Ctx> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-tag-preview-'));
  mkdirSync(join(root, 'topics'), {recursive: true});
  // a reads as about the tag to be created; b is unrelated; c carries survey
  // and reads as about it; d reads as about a second, minted tag.
  writeFileSync(join(root, 'topics/a.md'), note('A', '', tagEmbedText('field-survey', FIELD_DESC)));
  writeFileSync(join(root, 'topics/b.md'), note('B', '', 'Something else entirely.'));
  writeFileSync(
    join(root, 'topics/c.md'),
    note('C', 'survey', tagEmbedText('survey', SURVEY_DESC))
  );
  writeFileSync(
    join(root, 'topics/d.md'),
    note('D', '', tagEmbedText('field-survey-2', FIELD_DESC))
  );
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  db.prepare(
    "INSERT INTO tags_taxonomy (tag, description, added, origin) VALUES ('survey', ?, '2026-09-01', 'minted'), ('competitive', 'Comparisons against competing products.', '2026-09-01', 'minted')"
  ).run(SURVEY_DESC);
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
  const url = `http://127.0.0.1:${port}`;
  const embedded = await api(`${url}/maintenance/embed-pending`, 'POST');
  if (embedded.status !== 200) throw new Error('embed-pending failed');
  return {root, db, handle, url};
};

const stopCtx = async (ctx: Ctx): Promise<void> => {
  await ctx.handle.close();
  ctx.db.close();
  rmSync(ctx.root, {recursive: true, force: true});
};

const suggestionsFor = (db: DatabaseSync, tag: string): any[] =>
  (
    db
      .prepare(
        `SELECT payload FROM suggestions
          WHERE kind = 'tag_suggestion' AND json_extract(payload, '$.tag') = ?`
      )
      .all(tag) as {payload: string}[]
  ).map(r => JSON.parse(r.payload));

test('a dry run previews overlaps and reach and creates nothing', async t => {
  const ctx = await startCtx();
  try {
    const r = await api(`${ctx.url}/tags/taxonomy`, 'POST', {
      tag: 'field-survey',
      description: FIELD_DESC,
      origin: 'manual',
      dry_run: true
    });
    t.equal(r.status, 200);
    t.equal(r.body.dry_run, true);
    t.equal(r.body.exists, false);
    const survey = r.body.overlaps.find((o: {tag: string}) => o.tag === 'survey');
    t.ok(survey, 'survey is among the overlaps');
    t.ok(survey.matched.includes('name'), 'matched by the shared word');
    t.equal(r.body.reach.threshold, 0.7);
    t.equal(r.body.reach.count, 1, 'one note reads as about it');
    t.match(r.body.reach.items[0], {title: 'A', file_path: 'topics/a.md', score: 1, tagged: false});
    const info = await api(`${ctx.url}/tags/field-survey`, 'GET');
    t.equal(info.status, 404, 'nothing created');
    t.equal(suggestionsFor(ctx.db, 'field-survey').length, 0, 'nothing filed');

    const bad = await api(`${ctx.url}/tags/taxonomy`, 'POST', {
      tag: 'x',
      description: 'y',
      dry_run: 'yes'
    });
    t.equal(bad.status, 400);
    const badFloor = await api(`${ctx.url}/tags/taxonomy`, 'POST', {
      tag: 'x',
      description: 'y',
      dry_run: true,
      reach_threshold: 2
    });
    t.equal(badFloor.status, 400);

    const all = await api(`${ctx.url}/tags/taxonomy`, 'POST', {
      tag: 'field-survey',
      description: FIELD_DESC,
      dry_run: true,
      reach_threshold: 0
    });
    t.equal(all.body.reach.threshold, 0);
    t.equal(all.body.reach.count, 4, 'a floor of zero shows every summarized note with its score');
    t.equal(all.body.reach.items[0].title, 'A', 'best first');
  } finally {
    await stopCtx(ctx);
  }
});

test('a manual create files a tag_suggestion for each untagged note in reach', async t => {
  const ctx = await startCtx();
  try {
    const r = await api(`${ctx.url}/tags/taxonomy`, 'POST', {
      tag: 'field-survey',
      description: FIELD_DESC,
      origin: 'manual'
    });
    t.equal(r.status, 200);
    t.equal(r.body.origin, 'manual');
    t.equal(r.body.reach.count, 1);
    t.equal(r.body.reach.filed, 1);
    t.ok(Array.isArray(r.body.overlaps), 'overlaps travel with the create too');
    const filed = suggestionsFor(ctx.db, 'field-survey');
    t.equal(filed.length, 1);
    t.equal(filed[0].file_path, 'topics/a.md');
    t.match(filed[0].evidence, {source: 'vector', asserted: false});

    const again = await api(`${ctx.url}/tags/taxonomy`, 'POST', {
      tag: 'field-survey',
      description: FIELD_DESC,
      origin: 'manual'
    });
    t.equal(again.status, 409, 'a real create of an existing tag still conflicts');
  } finally {
    await stopCtx(ctx);
  }
});

test('a minted create reports its reach but files nothing', async t => {
  const ctx = await startCtx();
  try {
    const r = await api(`${ctx.url}/tags/taxonomy`, 'POST', {
      tag: 'field-survey-2',
      description: FIELD_DESC
    });
    t.equal(r.status, 200);
    t.equal(r.body.origin, 'minted');
    t.equal(r.body.reach.count, 1, 'd reads as about it');
    t.equal(r.body.reach.filed, 0, 'a minted tag asks the sweep nothing');
    t.equal(suggestionsFor(ctx.db, 'field-survey-2').length, 0);
  } finally {
    await stopCtx(ctx);
  }
});

test('a dry run on an existing tag marks the notes carrying it, and an alias name is a likely overlap', async t => {
  const ctx = await startCtx();
  try {
    const existing = await api(`${ctx.url}/tags/taxonomy`, 'POST', {
      tag: 'survey',
      description: SURVEY_DESC,
      dry_run: true
    });
    t.equal(existing.status, 200, 'a dry run never conflicts');
    t.equal(existing.body.exists, true);
    t.match(existing.body.reach.items[0], {title: 'C', score: 1, tagged: true});
    t.notOk(
      existing.body.overlaps.some((o: {tag: string}) => o.tag === 'survey'),
      'the tag itself is not its own overlap'
    );

    const alias = await api(`${ctx.url}/tags/taxonomy`, 'POST', {
      tag: 'competitor',
      description: 'Rivals.',
      dry_run: true
    });
    t.equal(alias.status, 200);
    t.equal(alias.body.exists, false, 'an alias is not a taxonomy row');
    const competitive = alias.body.overlaps.find((o: {tag: string}) => o.tag === 'competitive');
    t.ok(competitive?.likely, 'a name that resolves to a tag is a likely overlap');
    t.ok(competitive.matched.includes('exact'));
  } finally {
    await stopCtx(ctx);
  }
});
