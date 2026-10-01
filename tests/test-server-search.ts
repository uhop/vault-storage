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

const startTestServer = async (
  vaultRoot: string,
  embedAfterImport = false,
  embedder: FakeEmbedder = new FakeEmbedder()
): Promise<ServerCtx> => {
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, vaultRoot);
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

class QueryRecordingEmbedder extends FakeEmbedder {
  readonly queries: string[] = [];
  override embedQuery(text: string): Promise<Float32Array> {
    this.queries.push(text);
    return super.embedQuery(text);
  }
}

test('POST /search/simple/?mode=semantic embeds the query as a query', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const embedder = new QueryRecordingEmbedder();
    const ctx = await startTestServer(root, true, embedder);
    try {
      await fetchAuthed(`${ctx.url}/search/simple/?query=docker&mode=semantic`, {method: 'POST'});
      t.deepEqual(
        embedder.queries,
        ['docker'],
        'through embedQuery, where BGE adds its instruction'
      );
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

test('POST /search/simple/ — unknown query parameter is a loud 400', async t => {
  const {root, cleanup} = setupVault();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/search/simple/?query=docker&mdoe=semantic`, {
        method: 'POST'
      });
      t.equal(r.status, 400, 'typo`d mode fails instead of silently searching lexically');
      t.ok((r.body as {error: string}).error.includes('mdoe'), 'offender named');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

// a supersedes b (declared), c cites b (a body link), d is related to a (mirrored), e has no edges.
const seedEdges = (root: string): void => {
  const note = (name: string, fm: string, body: string): void =>
    writeMd(root, `topics/${name}.md`, `---\ntitle: Cache ${name}\n${fm}---\n${body}\n`);
  note('a', 'edges:\n  topics/b: supersedes\n', 'The cache note a replaces [[topics/b]].');
  note('b', '', 'The cache note b.');
  note('c', '', 'The cache note c; see [[topics/b]].');
  note('d', 'related:\n  - "[[topics/a]]"\n', 'The cache note d.');
  note('e', '', 'The cache note e.');
};

const names = (body: unknown): string[] =>
  (body as Array<{filename: string}>).map(h => h.filename.replace(/^topics\/|\.md$/g, '')).sort();

test('POST /search/simple/ keeps the hits whose edges meet every edge condition', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedEdges(root);
    const ctx = await startTestServer(root);
    try {
      const idOf = (name: string): string =>
        (
          ctx.db
            .prepare('SELECT record_id FROM records WHERE file_path = ?')
            .get(`topics/${name}.md`) as {
            record_id: string;
          }
        ).record_id;
      const search = async (edge: string) =>
        fetchAuthed(`${ctx.url}/search/simple/?query=cache&${edge}`, {method: 'POST'});
      t.deepEqual(names((await search('edge=supersedes:outbound')).body), ['a']);
      t.deepEqual(names((await search('edge=supersedes:inbound')).body), ['b']);
      t.deepEqual(
        names((await search('edge=supersedes')).body),
        ['a', 'b'],
        'both ways by default'
      );
      t.deepEqual(
        names((await search('edge=!cites')).body),
        ['a', 'd', 'e'],
        '! keeps the hits without one'
      );
      t.deepEqual(
        names((await search(`edge=cites:outbound:${idOf('b')}`)).body),
        ['c'],
        'an edge to one note'
      );
      t.deepEqual(
        names((await search('edge=supersedes|related-to,!cites')).body),
        ['a', 'd'],
        '| within a condition, a comma between them'
      );
      t.deepEqual(
        names((await search('edge=supersedes|related-to&edge=!cites')).body),
        ['a', 'd'],
        'a repeated edge= is a second condition'
      );
      const bad = await search('edge=bogus:outbound');
      t.equal(bad.status, 400);
      t.matchString(bad.raw, /edge condition \\"bogus:outbound\\".*types: supersedes/);
      t.equal((await search('edge=cites:sideways')).status, 400, 'an unknown direction');
      t.equal((await search('edges=yes')).status, 400, 'edges takes 1 or 0');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /search/simple/?edges=1 adds each hit its record id and edges, a mirrored pair once', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedEdges(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/search/simple/?query=cache&edges=1`, {
        method: 'POST'
      });
      const hits = r.body as Array<{
        filename: string;
        record_id: string;
        edges: Array<{type: string; direction: string; other: {file_path: string}}>;
      }>;
      const a = hits.find(h => h.filename === 'topics/a.md')!;
      t.equal(typeof a.record_id, 'string');
      t.deepEqual(
        a.edges.map(e => [e.type, e.direction, e.other.file_path]),
        [
          ['supersedes', 'out', 'topics/b.md'],
          ['related-to', 'both', 'topics/d.md']
        ]
      );
      t.deepEqual(hits.find(h => h.filename === 'topics/e.md')!.edges, [], 'a hit with no edges');
      const plain = await fetchAuthed(`${ctx.url}/search/simple/?query=cache`, {method: 'POST'});
      t.notOk('record_id' in (plain.body as object[])[0]!, 'the plain answer keeps its shape');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /search/simple/?mode=semantic filters a wider window and says when it ran short', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedEdges(root);
    const ctx = await startTestServer(root, true);
    try {
      const url = `${ctx.url}/search/simple/?query=cache&mode=semantic&limit=1`;
      const related = await fetchAuthed(`${url}&edge=related-to`, {method: 'POST'});
      t.equal(related.status, 200);
      t.equal((related.body as unknown[]).length, 1, 'the one hit asked for');
      t.ok(['a', 'd'].includes(names(related.body)[0]!), 'a note with a related-to edge');
      const res = await fetch(`${url}&edge=contradicts`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${TEST_TOKEN}`}
      });
      t.deepEqual(await res.json(), [], 'no note contradicts another');
      t.equal(res.headers.get('x-vault-edge-window'), '5', 'the window it read');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /search/facets counts the hits with each type each way, over what a filter tests', async t => {
  const {root, cleanup} = setupVault();
  try {
    seedEdges(root);
    const ctx = await startTestServer(root, true);
    try {
      const lexical = await fetchAuthed(`${ctx.url}/search/facets?query=cache`, {method: 'POST'});
      t.equal(lexical.status, 200);
      const {as_of, ...counts} = lexical.body as {as_of: object};
      t.deepEqual(
        Object.keys(as_of),
        ['generation', 'indexed_commit', 'at'],
        'the stamp rides in the object body'
      );
      t.deepEqual(counts, {
        total: 5,
        edges: [
          {type: 'supersedes', direction: 'out', hits: 1},
          {type: 'supersedes', direction: 'in', hits: 1},
          {type: 'cites', direction: 'out', hits: 1},
          {type: 'cites', direction: 'in', hits: 1},
          {type: 'related-to', direction: 'both', hits: 2}
        ]
      });
      const semantic = await fetchAuthed(`${ctx.url}/search/facets?query=cache&mode=semantic`, {
        method: 'POST'
      });
      t.equal((semantic.body as {total: number}).total, 5, 'the nearest notes, all five here');
      const none = await fetchAuthed(`${ctx.url}/search/facets?query=nothing_matches`, {
        method: 'POST'
      });
      const {as_of: _, ...nothing} = none.body as {as_of: object};
      t.deepEqual(nothing, {total: 0, edges: []});
      t.equal(
        (await fetchAuthed(`${ctx.url}/search/facets?query=cache&edge=cites`, {method: 'POST'}))
          .status,
        400,
        'the counts take no conditions'
      );
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});
