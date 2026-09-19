import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import {BODY_FIELDS, RAW_BODY_ROUTES} from '../src/server/body-fields.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {buildRouter, startServer} from '../src/server/server.ts';

const TOKEN = 'test-token-body-fields';

const makeEnv = (vaultDataPath: string): ServerEnv => ({
  vaultDataPath,
  vaultIngestPath: null,
  vaultDbPath: ':memory:',
  apiToken: TOKEN,
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

test('every write route declares the JSON body fields it reads, and nothing else is declared', t => {
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  const routes = buildRouter({
    db,
    env: makeEnv(tmpdir()),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  }).routes();
  const writes = routes.filter(r => /^(POST|PUT|PATCH) /.test(r));
  for (const route of writes) {
    t.ok(BODY_FIELDS.has(route) || RAW_BODY_ROUTES.has(route), `${route} is declared`);
  }
  for (const route of [...BODY_FIELDS.keys(), ...RAW_BODY_ROUTES]) {
    t.ok(writes.includes(route), `${route} is a registered write route`);
  }
  db.close();
});

test('GET /system/body-fields reports the fields a route does not read, by client, and counts JSON requests', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vault-body-fields-'));
  mkdirSync(join(root, 'topics'), {recursive: true});
  writeFileSync(join(root, 'topics/alpha.md'), '---\ntitle: Alpha\n---\nBody.\n');
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
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
  const send = async (method: string, path: string, body: string, headers = {}) =>
    fetch(`${url}${path}`, {
      method,
      headers: {Authorization: `Bearer ${TOKEN}`, ...headers},
      body
    });
  try {
    await send(
      'POST',
      '/vault/edit',
      JSON.stringify({path: 'topics/alpha.md', op: 'append', text: 'More.', bogus: 1}),
      {'Content-Type': 'application/json', 'User-Agent': 'client-a/1'}
    );
    await send('POST', '/resolve', JSON.stringify({wikilinks: [], extra: true}), {
      'Content-Type': 'application/json',
      'User-Agent': 'client-b/2'
    });
    await send('PUT', '/vault/topics/alpha.md', '---\ntitle: Alpha\n---\nMarkdown body.\n', {
      'Content-Type': 'text/markdown'
    });
    await send(
      'PUT',
      '/vault/topics/alpha.md',
      JSON.stringify({frontmatter: {title: 'Alpha'}, body: 'JSON body.\n'}),
      {'Content-Type': 'application/json'}
    );

    const res = await fetch(`${url}/system/body-fields`, {
      headers: {Authorization: `Bearer ${TOKEN}`}
    });
    t.equal(res.status, 200);
    const report = (await res.json()) as {
      since: string | null;
      routes: Array<{
        route: string;
        requests: number;
        clients: Array<{client: string; requests: number}>;
        unknown: Array<{field: string; count: number; clients: string[]}>;
      }>;
    };
    const route = (name: string) => report.routes.find(r => r.route === name)!;
    t.ok(report.since, 'the observation window has a start');
    t.equal(route('POST /vault/edit').requests, 1);
    t.deepEqual(
      route('POST /vault/edit').unknown.map(u => [u.field, u.count, u.clients]),
      [['bogus', 1, ['client-a/1']]],
      'the field the route does not read, with its client'
    );
    t.deepEqual(
      route('POST /resolve').unknown.map(u => u.field),
      ['extra']
    );
    t.equal(route('PUT /vault/{path}').requests, 1, 'the markdown PUT is not a JSON request');
    t.deepEqual(route('PUT /vault/{path}').unknown, [], 'declared fields are not reported');
    t.equal(route('POST /leases/transfer').requests, 0, 'an unused route reads as untested');
    t.deepEqual(route('POST /vault/edit').clients, [{client: 'client-a/1', requests: 1}]);

    const bad = await fetch(`${url}/system/body-fields?route=x`, {
      headers: {Authorization: `Bearer ${TOKEN}`}
    });
    t.equal(bad.status, 400, 'no query parameters');
  } finally {
    await handle.close();
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});
