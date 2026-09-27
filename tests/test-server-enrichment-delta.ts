// GET /sections/{id}/enrichment-delta — the chunks added to a body since its
// `agent:` block was last current. Covers: the baseline written by an enriched
// write, an appended section read as a small delta, a re-enrichment replacing
// the baseline, a record never enriched, and the 404/400 paths.

import test from 'tape-six';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import {backfillEnrichmentBaselines} from '../src/maintenance/backfill-enrichment-baselines.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-enrichment-delta';

const makeEnv = (dataPath: string): ServerEnv => ({
  vaultDataPath: dataPath,
  vaultIngestPath: null,
  vaultDbPath: ':memory:',
  apiToken: TEST_TOKEN,
  host: '127.0.0.1',
  port: 0,
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

const paragraph = (seed: string): string =>
  Array.from({length: 12}, (_, i) => `${seed} sentence ${i} about the decision.`).join(' ');

const section = (n: number): string =>
  `## D${n}\n\n${paragraph(`D${n} first`)}\n\n${paragraph(`D${n} second`)}\n`;

const BODY = [1, 2, 3, 4, 5].map(section).join('\n');

const AGENT = {
  summary: 'A decisions log, D1 through D5.',
  key_concepts: ['decisions'],
  tags_suggested: [],
  related_proposed: [],
  edge_classifications: {},
  complexity: 'log-entry',
  derived_from_hash: 'auto'
};

interface Setup {
  root: string;
  db: DatabaseSync;
  handle: ServerHandle;
  url: string;
}

const start = async (): Promise<Setup> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-enrichment-delta-test-'));
  mkdirSync(join(root, 'projects/demo'), {recursive: true});
  writeFileSync(
    join(root, 'projects/demo/decisions.md'),
    `---\ntitle: Decisions\ntype: project\n---\n${BODY}`,
    'utf8'
  );
  writeFileSync(
    join(root, 'projects/demo/plain.md'),
    `---\ntitle: Plain\ntype: project\n---\nNo agent block here.\n`,
    'utf8'
  );
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, root);
  const handle = await startServer({
    db,
    env: makeEnv(root),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {root, db, handle, url: `http://127.0.0.1:${port}`};
};

const stop = async (s: Setup): Promise<void> => {
  await s.handle.close();
  s.db.close();
  rmSync(s.root, {recursive: true, force: true});
};

const call = async (
  url: string,
  init: RequestInit = {}
): Promise<{status: number; body: Record<string, unknown>}> => {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${TEST_TOKEN}`);
  if (init.body !== undefined) headers.set('Content-Type', 'application/json');
  const res = await fetch(url, {...init, headers});
  const text = await res.text();
  return {status: res.status, body: text.length === 0 ? {} : JSON.parse(text)};
};

const recordId = (db: DatabaseSync, path: string): string =>
  (db.prepare('SELECT record_id FROM records WHERE file_path = ?').get(path) as {record_id: string})
    .record_id;

const write = (s: Setup, body: string, agent?: Record<string, unknown>) =>
  call(`${s.url}/vault/projects/demo/decisions.md`, {
    method: 'PUT',
    body: JSON.stringify({frontmatter: agent ? {agent} : {}, body})
  });

test('enrichment delta', async t => {
  const s = await start();
  try {
    const id = recordId(s.db, 'projects/demo/decisions.md');
    const delta = (): Promise<{status: number; body: Record<string, unknown>}> =>
      call(`${s.url}/sections/${id}/enrichment-delta`);

    await t.test('a body never enriched has no baseline', async t => {
      const r = await delta();
      t.equal(r.status, 200);
      t.equal(r.body['baseline'], null);
      t.equal(r.body['agent_current'], false);
    });

    await t.test('an enriched write records the baseline', async t => {
      const w = await write(s, BODY, AGENT);
      t.equal(w.status, 204);
      const r = await delta();
      t.equal(r.body['agent_current'], true);
      t.ok(r.body['baseline'], 'baseline present');
      t.match(r.body['chunks'], {added: 0, removed: 0});
      t.equal(r.body['changed_fraction'], 0);
      t.deepEqual(r.body['added_chunks'], []);
    });

    await t.test('an appended section reads as its own chunks only', async t => {
      const w = await write(s, `${BODY}\n${section(6)}`);
      t.equal(w.status, 204);
      const r = await delta();
      t.equal(r.body['agent_current'], false);
      const chunks = r.body['chunks'] as {total: number; added: number; removed: number};
      t.equal(chunks.removed, 0);
      t.ok(chunks.added > 0 && chunks.added < chunks.total, 'some, not all, chunks added');
      const added = r.body['added_chunks'] as {index: number; text: string}[];
      t.ok(
        added.every(c => c.text.startsWith('D6')),
        'every added chunk is the new section'
      );
      t.ok((r.body['changed_fraction'] as number) < 0.4, 'a small fraction');
    });

    await t.test('re-enrichment replaces the baseline', async t => {
      const w = await write(s, `${BODY}\n${section(6)}`, AGENT);
      t.equal(w.status, 204);
      const r = await delta();
      t.equal(r.body['agent_current'], true);
      t.match(r.body['chunks'], {added: 0, removed: 0});
    });

    await t.test('a record with no agent block has no baseline', async t => {
      const r = await call(
        `${s.url}/sections/${recordId(s.db, 'projects/demo/plain.md')}/enrichment-delta`
      );
      t.equal(r.status, 200);
      t.equal(r.body['baseline'], null);
    });

    await t.test('an unknown record is a 404, an unknown parameter a 400', async t => {
      t.equal((await call(`${s.url}/sections/nope/enrichment-delta`)).status, 404);
      t.equal((await call(`${s.url}/sections/${id}/enrichment-delta?x=1`)).status, 400);
    });
  } finally {
    await stop(s);
  }
});

test('enrichment baseline backfill', async t => {
  const s = await start();
  try {
    await write(s, BODY, AGENT);
    const id = recordId(s.db, 'projects/demo/decisions.md');
    s.db.prepare('DELETE FROM enrichment_baselines').run();

    const first = await backfillEnrichmentBaselines(s.db);
    t.match(first, {candidates: 1, written: 1, skipped: 0});
    const r = await call(`${s.url}/sections/${id}/enrichment-delta`);
    t.ok(r.body['baseline'], 'baseline restored');

    const second = await backfillEnrichmentBaselines(s.db);
    t.match(second, {candidates: 0, written: 0});
  } finally {
    await stop(s);
  }
});
