// POST /vault/supersede — replace a note with a successor, archiving the
// superseded one (decision 2026-06-11: archived, not tombstoned).
// Covers: in-place default, distinct new_path, record-id preservation,
// status stamp, supersedes-edge merge, validation-first atomicity, and
// the collision/404 surfaces.

import test from 'tape-six';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-supersede';
const YEAR = new Date().getFullYear();

const setupVault = (): {root: string; cleanup: () => void} => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-supersede-test-'));
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
): Promise<{status: number; body: unknown; text: string}> => {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${TEST_TOKEN}`);
  const res = await fetch(url, {...init, headers});
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text.length === 0 ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  return {status: res.status, body, text};
};

const putNote = (
  url: string,
  path: string,
  frontmatter: Record<string, unknown>,
  body: string
): Promise<{status: number; body: unknown; text: string}> =>
  authedFetch(`${url}/vault/${path}`, {
    method: 'PUT',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({frontmatter, body})
  });

const supersede = (
  url: string,
  payload: Record<string, unknown>
): Promise<{status: number; body: unknown; text: string}> =>
  authedFetch(`${url}/vault/supersede`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(payload)
  });

interface SupersedeResponse {
  old: {path: string; record_id: string};
  new: {path: string; record_id: string | null; etag: string};
}

test('supersede in place: old archived with status + record_id intact, successor takes the path', async t => {
  const {root, cleanup} = setupVault();
  try {
    const {db, handle, url} = await startTestServer(root);
    try {
      await putNote(
        url,
        'topics/flange.md',
        {title: 'Flange v1', tags: ['widgets'], status: 'active', type: 'permanent'},
        'The old flange doctrine.'
      );
      const before = await authedFetch(`${url}/sections?file_path=topics/flange.md`);
      const oldId = (before.body as {items: Array<{record_id: string}>}).items[0]?.record_id;

      const {status, body} = await supersede(url, {
        old_path: 'topics/flange.md',
        frontmatter: {title: 'Flange v2', tags: ['widgets'], status: 'active', type: 'permanent'},
        body: 'The new flange doctrine, consolidated.'
      });
      t.equal(status, 200, '200 ok');
      const res = body as SupersedeResponse;
      t.equal(res.old.path, `topics/archive/${YEAR}/flange.md`, 'old archived under the year folder');
      t.equal(res.old.record_id, oldId, 'archived record keeps its record_id');
      t.equal(res.new.path, 'topics/flange.md', 'successor takes the original path');
      t.ok(res.new.record_id, 'successor has a record');
      t.notEqual(res.new.record_id, oldId, 'successor is a distinct record');
      t.ok(res.new.etag, 'etag returned for chained conditional writes');

      const successor = await authedFetch(`${url}/vault/topics/flange.md`);
      t.ok(successor.text.includes('new flange doctrine'), 'original path serves the successor');
      t.ok(
        successor.text.includes(`topics/archive/${YEAR}/flange: supersedes`),
        'successor FM carries the supersedes edge to the archived path'
      );

      const archived = await authedFetch(`${url}/vault/topics/archive/${YEAR}/flange.md`);
      t.equal(archived.status, 200, 'archived copy readable');
      t.ok(archived.text.includes('old flange doctrine'), 'archived copy keeps the old body');
      t.ok(archived.text.includes('status: superseded'), 'archived copy stamped superseded');

      void db;
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('supersede to a new path: old path vacated, caller edges preserved in the merge', async t => {
  const {root, cleanup} = setupVault();
  try {
    const {db, handle, url} = await startTestServer(root);
    try {
      await putNote(url, 'topics/old-name.md', {title: 'Old', type: 'permanent'}, 'Old content.');
      await putNote(url, 'topics/anchor.md', {title: 'Anchor', type: 'permanent'}, 'Anchor.');

      const {status, body} = await supersede(url, {
        old_path: 'topics/old-name.md',
        new_path: 'topics/new-name.md',
        frontmatter: {
          title: 'New',
          type: 'permanent',
          edges: {'topics/anchor': 'derived-from'}
        },
        body: 'New content at a new home.'
      });
      t.equal(status, 200, '200 ok');
      t.equal((body as SupersedeResponse).new.path, 'topics/new-name.md', 'successor at new_path');

      const vacated = await authedFetch(`${url}/vault/topics/old-name.md`);
      t.equal(vacated.status, 404, 'old path vacated');

      const successor = await authedFetch(`${url}/vault/topics/new-name.md`);
      t.ok(successor.text.includes('topics/anchor: derived-from'), 'caller edge survives');
      t.ok(
        successor.text.includes(`topics/archive/${YEAR}/old-name: supersedes`),
        'supersedes edge merged alongside'
      );
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('supersede validates before mutating: bad payload leaves the old note untouched', async t => {
  const {root, cleanup} = setupVault();
  try {
    const {db, handle, url} = await startTestServer(root);
    try {
      await putNote(url, 'topics/safe.md', {title: 'Safe', type: 'permanent'}, 'Safe body.');

      const {status, body} = await supersede(url, {
        old_path: 'topics/safe.md',
        frontmatter: {title: 'Broken', status: 'bogus-status'},
        body: 'never lands'
      });
      t.equal(status, 400, 'enum violation rejected');
      t.equal((body as {code: string}).code, 'invalid_enum_value', 'writer pre-flight fired');

      const original = await authedFetch(`${url}/vault/topics/safe.md`);
      t.equal(original.status, 200, 'old note still at its path');
      t.ok(original.text.includes('Safe body.'), 'old content untouched');
      const archive = await authedFetch(`${url}/vault/topics/archive/${YEAR}/safe.md`);
      t.equal(archive.status, 404, 'nothing archived');
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});

test('supersede collision + missing surfaces: 404 old, 409 new_path, 409 archive slot', async t => {
  const {root, cleanup} = setupVault();
  try {
    const {db, handle, url} = await startTestServer(root);
    try {
      let res = await supersede(url, {
        old_path: 'topics/ghost.md',
        frontmatter: {title: 'X'},
        body: 'x'
      });
      t.equal(res.status, 404, 'unknown old_path → 404');

      await putNote(url, 'topics/a.md', {title: 'A', type: 'permanent'}, 'A body.');
      await putNote(url, 'topics/b.md', {title: 'B', type: 'permanent'}, 'B body.');
      res = await supersede(url, {
        old_path: 'topics/a.md',
        new_path: 'topics/b.md',
        frontmatter: {title: 'New A'},
        body: 'x'
      });
      t.equal(res.status, 409, 'occupied new_path → 409');

      await putNote(
        url,
        `topics/archive/${YEAR}/a.md`,
        {title: 'Old archive squatter', type: 'permanent'},
        'Already here.'
      );
      res = await supersede(url, {
        old_path: 'topics/a.md',
        frontmatter: {title: 'New A'},
        body: 'x'
      });
      t.equal(res.status, 409, 'occupied archive slot → 409');
      const untouched = await authedFetch(`${url}/vault/topics/a.md`);
      t.ok(untouched.text.includes('A body.'), 'old note untouched after both 409s');
    } finally {
      await teardown(db, handle);
    }
  } finally {
    cleanup();
  }
});
