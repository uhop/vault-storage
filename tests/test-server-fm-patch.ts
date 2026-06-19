// PATCH /sections/{id}/fm — value-based membership ops on FM arrays.
// Covers: add/remove set semantics, array + intermediate creation, no-op
// requests skipping the disk write (no `updated` churn), protected roots,
// non-array targets, atomicity of multi-op requests, and envelope shape
// validation.

import test from 'tape-six';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-fm-patch';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setupVault = (): {root: string; cleanup: () => void} => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-fm-patch-test-'));
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

const startTestServer = async (
  vaultRoot: string
): Promise<{db: DatabaseSync; handle: ServerHandle; url: string}> => {
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

const teardown = async (db: DatabaseSync, handle: ServerHandle): Promise<void> => {
  await handle.close();
  db.close();
};

const authedFetch = async (
  url: string,
  init: RequestInit = {}
): Promise<{status: number; body: unknown}> => {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${TEST_TOKEN}`);
  const res = await fetch(url, {...init, headers});
  const text = await res.text();
  const body = text.length === 0 ? null : JSON.parse(text);
  return {status: res.status, body};
};

/** A note with an enrichment block — the motivating shape. */
const ENRICHED_NOTE = [
  '---',
  'title: Enriched',
  'tags:',
  '  - keep-tag',
  'created: 2026-05-01',
  'updated: 2026-05-20',
  'status: active',
  'type: permanent',
  'related:',
  '  - "[[topics/other]]"',
  'agent:',
  '  derived_at: 2026-05-20T00:00:00Z',
  '  derived_from_hash: abc123',
  '  summary: A summary.',
  '  tags_suggested:',
  '    - race-condition',
  '    - keep-me',
  '---',
  'Enriched body.',
  ''
].join('\n');

interface PatchResponse {
  changed: boolean;
  results: Array<{op: string; path: string; changed: boolean; array: unknown[] | null}>;
}

interface FmResponse {
  frontmatter: Record<string, unknown>;
}

const recordId = async (url: string, filePath: string): Promise<string> => {
  const list = await authedFetch(`${url}/sections?file_path=${encodeURIComponent(filePath)}`);
  const id = (list.body as {items: Array<{record_id: string}>}).items[0]?.record_id;
  if (!id) throw new Error(`no record for ${filePath}`);
  return id;
};

const patchFm = (url: string, id: string, ops: unknown): Promise<{status: number; body: unknown}> =>
  authedFetch(`${url}/sections/${id}/fm`, {
    method: 'PATCH',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ops})
  });

const getAgent = async (url: string, id: string): Promise<Record<string, unknown>> => {
  const fm = await authedFetch(`${url}/sections/${id}/fm?exclude=body`);
  return ((fm.body as FmResponse).frontmatter['agent'] ?? {}) as Record<string, unknown>;
};

test('PATCH fm: remove by value from agent.tags_suggested (the motivating case)', async t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/note.md', ENRICHED_NOTE);
    const {db, handle, url} = await startTestServer(root);
    try {
      const id = await recordId(url, 'topics/note.md');
      const {status, body} = await patchFm(url, id, [
        {op: 'remove', path: '/agent/tags_suggested', value: 'race-condition'}
      ]);
      t.equal(status, 200, '200 ok');
      const res = body as PatchResponse;
      t.ok(res.changed, 'request changed the record');
      t.deepEqual(res.results[0]?.array, ['keep-me'], 'result reports the final array');

      const agent = await getAgent(url, id);
      t.deepEqual(agent['tags_suggested'], ['keep-me'], 'removal persisted to disk');
      t.equal(agent['summary'], 'A summary.', 'untouched agent fields survive');
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('PATCH fm: add is set-semantics and remove is idempotent (no-ops skip the write)', async t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/note.md', ENRICHED_NOTE);
    const {db, handle, url} = await startTestServer(root);
    try {
      const id = await recordId(url, 'topics/note.md');
      const before = await authedFetch(`${url}/sections/${id}/fm?exclude=body`);
      const updatedBefore = (before.body as FmResponse).frontmatter['updated'];

      const {status, body} = await patchFm(url, id, [
        {op: 'add', path: '/agent/tags_suggested', value: 'keep-me'},
        {op: 'remove', path: '/agent/tags_suggested', value: 'not-there'},
        {op: 'remove', path: '/agent/no_such_array', value: 'x'}
      ]);
      t.equal(status, 200, '200 ok');
      const res = body as PatchResponse;
      t.notOk(res.changed, 'all ops are no-ops');
      t.deepEqual(
        res.results.map(r => r.changed),
        [false, false, false],
        'each op reports unchanged'
      );
      t.equal(res.results[2]?.array, null, 'missing path reports a null array');

      const after = await authedFetch(`${url}/sections/${id}/fm?exclude=body`);
      t.equal(
        (after.body as FmResponse).frontmatter['updated'],
        updatedBefore,
        'no-op request did not re-stamp `updated` (no disk write)'
      );
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('PATCH fm: add creates a missing array and missing intermediates', async t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/note.md', ENRICHED_NOTE);
    const {db, handle, url} = await startTestServer(root);
    try {
      const id = await recordId(url, 'topics/note.md');
      const {status, body} = await patchFm(url, id, [
        {op: 'add', path: '/agent/related_proposed', value: '[[topics/new-friend]]'},
        {op: 'add', path: '/review/notes_pending', value: 'first'}
      ]);
      t.equal(status, 200, '200 ok');
      t.ok((body as PatchResponse).changed, 'changed');

      const fm = await authedFetch(`${url}/sections/${id}/fm?exclude=body`);
      const data = (fm.body as FmResponse).frontmatter;
      const agent = data['agent'] as Record<string, unknown>;
      t.deepEqual(
        agent['related_proposed'],
        ['[[topics/new-friend]]'],
        'array created inside the existing agent block'
      );
      t.deepEqual(
        data['review'],
        {notes_pending: ['first']},
        'missing intermediate object created'
      );
      t.deepEqual(
        agent['tags_suggested'],
        ['race-condition', 'keep-me'],
        'sibling arrays untouched'
      );
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('PATCH fm: top-level array (related) is patchable', async t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/note.md', ENRICHED_NOTE);
    const {db, handle, url} = await startTestServer(root);
    try {
      const id = await recordId(url, 'topics/note.md');
      const {status} = await patchFm(url, id, [
        {op: 'add', path: '/related', value: '[[topics/second]]'}
      ]);
      t.equal(status, 200, '200 ok');
      const fm = await authedFetch(`${url}/sections/${id}/fm?exclude=body`);
      t.deepEqual(
        (fm.body as FmResponse).frontmatter['related'],
        ['[[topics/other]]', '[[topics/second]]'],
        'related extended in place'
      );
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('PATCH fm: protected roots are rejected', async t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/note.md', ENRICHED_NOTE);
    const {db, handle, url} = await startTestServer(root);
    try {
      const id = await recordId(url, 'topics/note.md');
      for (const [path, expected] of [
        ['/tags', 'tags'],
        ['/created', 'created'],
        ['/record_id', 'record_id']
      ] as const) {
        const {status, body} = await patchFm(url, id, [{op: 'add', path, value: 'x'}]);
        t.equal(status, 400, `${path} → 400`);
        t.equal((body as {code: string}).code, 'protected_field', `${path} → protected_field`);
        t.ok((body as {error: string}).error.includes(expected), `${path} error names the field`);
      }
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('PATCH fm: non-array target and non-object intermediate are 400s', async t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/note.md', ENRICHED_NOTE);
    const {db, handle, url} = await startTestServer(root);
    try {
      const id = await recordId(url, 'topics/note.md');
      let res = await patchFm(url, id, [{op: 'add', path: '/title', value: 'x'}]);
      t.equal(res.status, 400, 'scalar target → 400');
      t.equal((res.body as {code: string}).code, 'invalid_target', 'invalid_target on scalar');

      res = await patchFm(url, id, [{op: 'add', path: '/title/deep', value: 'x'}]);
      t.equal(res.status, 400, 'descending into a scalar → 400');

      res = await patchFm(url, id, [{op: 'add', path: '/related/deep', value: 'x'}]);
      t.equal(res.status, 400, 'descending into an array → 400');
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('PATCH fm: multi-op requests are atomic — a failing op writes nothing', async t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/note.md', ENRICHED_NOTE);
    const {db, handle, url} = await startTestServer(root);
    try {
      const id = await recordId(url, 'topics/note.md');
      const {status} = await patchFm(url, id, [
        {op: 'add', path: '/agent/tags_suggested', value: 'should-not-land'},
        {op: 'add', path: '/tags', value: 'nope'}
      ]);
      t.equal(status, 400, 'request rejected on the second op');

      const agent = await getAgent(url, id);
      t.deepEqual(
        agent['tags_suggested'],
        ['race-condition', 'keep-me'],
        'first op was not persisted'
      );
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('PATCH fm: envelope validation', async t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/note.md', ENRICHED_NOTE);
    const {db, handle, url} = await startTestServer(root);
    try {
      const id = await recordId(url, 'topics/note.md');

      let res = await patchFm(url, id, []);
      t.equal(res.status, 400, 'empty ops → 400');

      res = await patchFm(url, id, [{op: 'replace', path: '/related', value: 'x'}]);
      t.equal(res.status, 400, 'unknown op → 400');

      res = await patchFm(url, id, [{op: 'add', path: '/related'}]);
      t.equal(res.status, 400, 'missing value → 400');

      res = await patchFm(url, id, [{op: 'add', path: 'related', value: 'x'}]);
      t.equal(res.status, 400, 'pointer without leading slash → 400');

      res = await patchFm(url, id, [{op: 'add', path: '/', value: 'x'}]);
      t.equal(res.status, 400, 'root pointer → 400');

      res = await authedFetch(`${url}/sections/${id}/fm`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: 'not json'
      });
      t.equal(res.status, 400, 'non-JSON body → 400');

      res = await authedFetch(`${url}/sections/no-such-id/fm`, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ops: [{op: 'add', path: '/related', value: 'x'}]})
      });
      t.equal(res.status, 404, 'unknown record → 404');
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('PATCH fm: structural values (objects) use deep equality', async t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(root, 'topics/note.md', ENRICHED_NOTE);
    const {db, handle, url} = await startTestServer(root);
    try {
      const id = await recordId(url, 'topics/note.md');
      const entry = {path: 'topics/x.md', why: 'sibling'};
      let res = await patchFm(url, id, [{op: 'add', path: '/review_queue', value: entry}]);
      t.equal(res.status, 200, 'object value accepted');
      res = await patchFm(url, id, [{op: 'add', path: '/review_queue', value: entry}]);
      t.notOk((res.body as PatchResponse).changed, 'deep-equal duplicate is a no-op');
      res = await patchFm(url, id, [{op: 'remove', path: '/review_queue', value: entry}]);
      t.ok((res.body as PatchResponse).changed, 'deep-equal remove matches');
      const fm = await authedFetch(`${url}/sections/${id}/fm?exclude=body`);
      t.deepEqual(
        (fm.body as FmResponse).frontmatter['review_queue'],
        [],
        'array left empty after removal'
      );
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});
