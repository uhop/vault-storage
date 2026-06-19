import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {embedPending} from '../src/embeddings/embed-pass.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-search';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setupVault = (): {root: string; cleanup: () => void} => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-search-test-'));
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

const startTestServer = async (vaultRoot: string, embedAfterImport = false): Promise<ServerCtx> => {
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, vaultRoot);
  const embedder = new FakeEmbedder();
  if (embedAfterImport) {
    await embedPending(db, embedder);
  }
  const handle = await startServer({
    db,
    env: makeEnv(0, vaultRoot),
    schemaVersion: migration.current,
    embedder
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
): Promise<{status: number; body: unknown; raw: string}> => {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${TEST_TOKEN}`);
  const res = await fetch(url, {...init, headers});
  const raw = await res.text();
  const body = raw.length === 0 ? null : JSON.parse(raw);
  return {status: res.status, body, raw};
};

const seed = (root: string): void => {
  writeMd(
    root,
    'topics/docker-networking.md',
    [
      '---',
      'title: Docker networking',
      'created: 2026-04-01',
      'updated: 2026-04-15',
      '---',
      'How to configure docker bridge networks. Docker supports multiple drivers.',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'topics/kubernetes-pods.md',
    [
      '---',
      'title: Kubernetes pods',
      'created: 2026-04-10',
      'updated: 2026-04-20',
      '---',
      'Pods group containers. Often deployed alongside docker-built images.',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'topics/redis-cache.md',
    [
      '---',
      'title: Redis cache layer',
      'created: 2026-04-05',
      'updated: 2026-04-12',
      '---',
      'Caching strategies for hot reads. No relevance to containers.',
      ''
    ].join('\n')
  );
};

test('POST /search/simple/?query=docker returns lexical hits', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/search/simple/?query=docker`, {method: 'POST'});
      t.equal(r.status, 200, '200 ok');
      const hits = r.body as Array<{filename: string; score: number; matches: unknown[]}>;
      t.ok(hits.length >= 2, 'at least two hits (docker-networking + kubernetes-pods)');
      const filenames = new Set(hits.map(h => h.filename));
      t.ok(filenames.has('topics/docker-networking.md'), 'docker-networking matched');
      t.ok(filenames.has('topics/kubernetes-pods.md'), 'kubernetes-pods matched');
      t.notOk(filenames.has('topics/redis-cache.md'), 'redis-cache not matched');

      const top = hits[0]!;
      t.ok(top.score > 0, 'score is positive');
      t.ok(top.matches.length > 0, 'has at least one match');
      const m = top.matches[0] as {match: {start: number; end: number}; context: string};
      t.equal(typeof m.match.start, 'number', 'match.start is number');
      t.equal(typeof m.context, 'string', 'context is string');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /search/simple/ scores title matches higher than body matches', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/search/simple/?query=docker`, {method: 'POST'});
      const hits = r.body as Array<{filename: string; score: number}>;
      const dockerNet = hits.find(h => h.filename === 'topics/docker-networking.md');
      const k8s = hits.find(h => h.filename === 'topics/kubernetes-pods.md');
      t.ok(dockerNet, 'docker-networking present');
      t.ok(k8s, 'kubernetes-pods present');
      t.ok(dockerNet!.score > k8s!.score, 'title-match scored higher than body-only');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /search/simple/ requires a query', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/search/simple/`, {method: 'POST'});
      t.equal(r.status, 400, '400 bad request');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /search/simple/?query=&mode=bogus returns 400', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/search/simple/?query=docker&mode=bogus`, {
        method: 'POST'
      });
      t.equal(r.status, 400, '400 bad request');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /search/simple/?mode=semantic returns embedding hits', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root, true);
    try {
      const r = await fetchAuthed(`${ctx.url}/search/simple/?query=docker&mode=semantic&limit=3`, {
        method: 'POST'
      });
      t.equal(r.status, 200, '200 ok');
      const hits = r.body as Array<{filename: string; score: number}>;
      t.ok(hits.length > 0, 'returns at least one semantic hit');
      t.ok(
        hits.every(h => typeof h.filename === 'string'),
        'every hit has a filename'
      );
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /search/simple/?query=ridiculous_no_match returns empty array', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/search/simple/?query=zzzzz_no_match_anywhere`, {
        method: 'POST'
      });
      t.equal(r.status, 200, '200 ok');
      t.deepEqual(r.body, [], 'empty array');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /search/simple/ is case-insensitive (uppercase query matches lowercase body + Titlecase title)', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      // Body has "docker"/"Docker"; title is "Docker networking". An
      // all-uppercase query must still match — the old LOWER-asymmetry let a
      // differently-cased query miss the note.
      const r = await fetchAuthed(`${ctx.url}/search/simple/?query=DOCKER`, {method: 'POST'});
      t.equal(r.status, 200, '200 ok');
      const hits = r.body as Array<{filename: string}>;
      const filenames = new Set(hits.map(h => h.filename));
      t.ok(filenames.has('topics/docker-networking.md'), 'uppercase query matched the note');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /search/simple/ multi-word query matches non-adjacent terms (AND semantics)', async t => {
  const {root, cleanup} = setupVault();
  try {
    writeMd(
      root,
      'topics/scatter.md',
      [
        '---',
        'title: Scatter',
        'created: 2026-04-01',
        'updated: 2026-04-15',
        '---',
        'Alpha leads the section. Several sentences intervene before gamma trails at the end.',
        ''
      ].join('\n')
    );
    writeMd(
      root,
      'topics/partial.md',
      [
        '---',
        'title: Partial',
        'created: 2026-04-01',
        'updated: 2026-04-16',
        '---',
        'Only alpha appears here, never the other term.',
        ''
      ].join('\n')
    );
    const ctx = await startTestServer(root);
    try {
      // Both terms present but far apart → matches (the old single-substring
      // LIKE required adjacency and returned nothing here).
      const both = await fetchAuthed(`${ctx.url}/search/simple/?query=alpha%20gamma`, {
        method: 'POST'
      });
      t.equal(both.status, 200, '200 ok');
      const bothNames = new Set((both.body as Array<{filename: string}>).map(h => h.filename));
      t.ok(bothNames.has('topics/scatter.md'), 'note with both terms matched');
      t.notOk(bothNames.has('topics/partial.md'), 'note missing a term excluded (AND, not OR)');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /search/simple/ scores all matches before applying limit (title match survives)', async t => {
  const {root, cleanup} = setupVault();
  try {
    // Three body-only matches with newer `updated`, one title match that is
    // older. The old code sliced to `limit` in updated-DESC order *before*
    // scoring, dropping the older title match; the fix scores everything
    // first, so the higher-scoring title match wins a small limit.
    writeMd(
      root,
      'topics/body-1.md',
      [
        '---',
        'title: Body one',
        'created: 2026-05-01',
        'updated: 2026-05-10',
        '---',
        'a common mention',
        ''
      ].join('\n')
    );
    writeMd(
      root,
      'topics/body-2.md',
      [
        '---',
        'title: Body two',
        'created: 2026-05-01',
        'updated: 2026-05-11',
        '---',
        'another common mention',
        ''
      ].join('\n')
    );
    writeMd(
      root,
      'topics/body-3.md',
      [
        '---',
        'title: Body three',
        'created: 2026-05-01',
        'updated: 2026-05-12',
        '---',
        'common once more',
        ''
      ].join('\n')
    );
    writeMd(
      root,
      'topics/titled.md',
      [
        '---',
        'title: Common matters',
        'created: 2026-01-01',
        'updated: 2026-01-01',
        '---',
        'nothing relevant in the body',
        ''
      ].join('\n')
    );
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/search/simple/?query=common&limit=2`, {
        method: 'POST'
      });
      t.equal(r.status, 200, '200 ok');
      const hits = r.body as Array<{filename: string; score: number}>;
      t.equal(hits.length, 2, 'respects limit');
      t.equal(
        hits[0]!.filename,
        'topics/titled.md',
        'title match ranks first despite being oldest'
      );
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /search/simple/ prefix-matches tokens, not infixes (FTS5 semantics)', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      // Prefix: "dock" matches the "docker" token via the FTS5 prefix query.
      const pre = await fetchAuthed(`${ctx.url}/search/simple/?query=dock`, {method: 'POST'});
      const preNames = new Set((pre.body as Array<{filename: string}>).map(h => h.filename));
      t.ok(preNames.has('topics/docker-networking.md'), 'prefix "dock" matched docker-networking');

      // Infix: "ocker" is a substring of "docker" but not a token prefix, so —
      // unlike the old LIKE '%term%' scan — it does not match.
      const infix = await fetchAuthed(`${ctx.url}/search/simple/?query=ocker`, {method: 'POST'});
      t.deepEqual(infix.body, [], 'infix "ocker" does not match (token-prefix, not substring)');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});
