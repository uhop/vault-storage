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
import {EdgesRepository} from '../src/records/edges.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-phase-b';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setup = (): {root: string; cleanup: () => void} => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-phase-b-test-'));
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

const startTestServer = async (vaultRoot: string, embed = false): Promise<ServerCtx> => {
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, vaultRoot);
  const embedder = new FakeEmbedder();
  if (embed) await embedPending(db, embedder);
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
): Promise<{status: number; body: unknown}> => {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${TEST_TOKEN}`);
  const res = await fetch(url, {...init, headers});
  const text = await res.text();
  const body = text.length === 0 ? null : JSON.parse(text);
  return {status: res.status, body};
};

const findId = async (url: string, filePath: string): Promise<string> => {
  const r = await fetchAuthed(`${url}/sections?file_path=${encodeURIComponent(filePath)}`);
  return (r.body as {items: Array<{record_id: string}>}).items[0]!.record_id;
};

const seedGraph = (root: string): void => {
  writeMd(
    root,
    'topics/alpha.md',
    [
      '---',
      'title: Alpha',
      'created: 2026-04-01',
      'updated: 2026-04-01',
      '---',
      'About alpha.',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'topics/beta.md',
    ['---', 'title: Beta', 'created: 2026-04-02', 'updated: 2026-04-02', '---', 'Beta.', ''].join(
      '\n'
    )
  );
  writeMd(
    root,
    'topics/gamma.md',
    ['---', 'title: Gamma', 'created: 2026-04-03', 'updated: 2026-04-03', '---', 'Gamma.', ''].join(
      '\n'
    )
  );
  writeMd(
    root,
    'topics/delta.md',
    ['---', 'title: Delta', 'created: 2026-04-04', 'updated: 2026-04-04', '---', 'Delta.', ''].join(
      '\n'
    )
  );
};

const wireEdges = async (
  ctx: ServerCtx,
  edges: Array<{from: string; to: string; type: string}>
): Promise<void> => {
  const repo = new EdgesRepository(ctx.db);
  for (const e of edges) {
    const fromId = await findId(ctx.url, e.from);
    const toId = await findId(ctx.url, e.to);
    repo.upsert({
      fromId,
      toId,
      type: e.type as never,
      weight: 1,
      note: null,
      created: '2026-04-29'
    });
  }
};

// ─── neighborhood ───────────────────────────────────────────────────────────

test('GET /sections/{id}/neighborhood returns root + 1-hop layer', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      // alpha → beta (cites), alpha → gamma (related-to)
      await wireEdges(ctx, [
        {from: 'topics/alpha.md', to: 'topics/beta.md', type: 'cites'},
        {from: 'topics/alpha.md', to: 'topics/gamma.md', type: 'related-to'}
      ]);
      const alphaId = await findId(ctx.url, 'topics/alpha.md');
      const r = await fetchAuthed(`${ctx.url}/sections/${alphaId}/neighborhood?depth=1`);
      t.equal(r.status, 200, '200 ok');
      const env = r.body as {
        root_id: string;
        depth: number;
        layers: Array<{depth: number; records: Array<{file_path: string}>}>;
        edges: Array<{type: string}>;
      };
      t.equal(env.root_id, alphaId, 'root is alpha');
      t.equal(env.layers.length, 1, 'single layer at depth=1');
      const paths = env.layers[0]!.records.map(r => r.file_path).sort();
      t.deepEqual(paths, ['topics/beta.md', 'topics/gamma.md'], 'beta + gamma reached');
      t.equal(env.edges.length, 2, 'two edges traversed');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections/{id}/neighborhood?via=cites filters edge types', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      await wireEdges(ctx, [
        {from: 'topics/alpha.md', to: 'topics/beta.md', type: 'cites'},
        {from: 'topics/alpha.md', to: 'topics/gamma.md', type: 'related-to'}
      ]);
      const alphaId = await findId(ctx.url, 'topics/alpha.md');
      const r = await fetchAuthed(`${ctx.url}/sections/${alphaId}/neighborhood?depth=1&via=cites`);
      const env = r.body as {layers: Array<{records: Array<{file_path: string}>}>};
      const paths = env.layers[0]!.records.map(r => r.file_path);
      t.deepEqual(paths, ['topics/beta.md'], 'only beta (cites)');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections/{id}/neighborhood?depth=2 chains across levels', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      // alpha → beta → gamma
      await wireEdges(ctx, [
        {from: 'topics/alpha.md', to: 'topics/beta.md', type: 'cites'},
        {from: 'topics/beta.md', to: 'topics/gamma.md', type: 'cites'}
      ]);
      const alphaId = await findId(ctx.url, 'topics/alpha.md');
      const r = await fetchAuthed(`${ctx.url}/sections/${alphaId}/neighborhood?depth=2`);
      const env = r.body as {layers: Array<{depth: number; records: Array<{file_path: string}>}>};
      t.equal(env.layers.length, 2, 'two layers');
      t.deepEqual(
        env.layers[0]!.records.map(r => r.file_path),
        ['topics/beta.md'],
        'layer 1: beta'
      );
      t.deepEqual(
        env.layers[1]!.records.map(r => r.file_path),
        ['topics/gamma.md'],
        'layer 2: gamma'
      );
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections/{unknown}/neighborhood returns 404', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/sections/01HFFFFFFFFFFFFFFFFFFFFFFFFF/neighborhood`);
      t.equal(r.status, 404, '404 not found');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

// ─── backlinks ──────────────────────────────────────────────────────────────

test('GET /sections/{id}/backlinks returns inbound edges', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      // alpha → gamma, beta → gamma
      await wireEdges(ctx, [
        {from: 'topics/alpha.md', to: 'topics/gamma.md', type: 'cites'},
        {from: 'topics/beta.md', to: 'topics/gamma.md', type: 'cites'}
      ]);
      const gammaId = await findId(ctx.url, 'topics/gamma.md');
      const r = await fetchAuthed(`${ctx.url}/sections/${gammaId}/backlinks`);
      t.equal(r.status, 200, '200 ok');
      const env = r.body as {
        items: Array<{from_record: {file_path: string}; edge: {type: string}}>;
        total: number;
      };
      t.equal(env.total, 2, 'two backlinks');
      const paths = env.items.map(i => i.from_record.file_path).sort();
      t.deepEqual(paths, ['topics/alpha.md', 'topics/beta.md'], 'alpha and beta cite gamma');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections/{id}/backlinks?type=cites filters by type', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      await wireEdges(ctx, [
        {from: 'topics/alpha.md', to: 'topics/gamma.md', type: 'cites'},
        {from: 'topics/beta.md', to: 'topics/gamma.md', type: 'related-to'}
      ]);
      const gammaId = await findId(ctx.url, 'topics/gamma.md');
      const r = await fetchAuthed(`${ctx.url}/sections/${gammaId}/backlinks?type=cites`);
      const env = r.body as {total: number};
      t.equal(env.total, 1, 'only cites match');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

// ─── similar ────────────────────────────────────────────────────────────────

test('GET /sections/{id}/similar returns nearest records (excluding self)', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root, true);
    try {
      const alphaId = await findId(ctx.url, 'topics/alpha.md');
      const r = await fetchAuthed(`${ctx.url}/sections/${alphaId}/similar?k=5`);
      t.equal(r.status, 200, '200 ok');
      const env = r.body as {root_id: string; items: Array<{record_id: string}>};
      t.equal(env.root_id, alphaId, 'root id echoed');
      t.ok(env.items.length > 0, 'at least one match');
      t.ok(
        env.items.every(i => i.record_id !== alphaId),
        'self excluded from results'
      );
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /sections/{id}/similar with no embeddings returns empty items', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root, false);
    try {
      const alphaId = await findId(ctx.url, 'topics/alpha.md');
      const r = await fetchAuthed(`${ctx.url}/sections/${alphaId}/similar`);
      t.equal(r.status, 200, '200 ok');
      const env = r.body as {items: unknown[]};
      t.equal(env.items.length, 0, 'no embeddings → no hits');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

// ─── tags ───────────────────────────────────────────────────────────────────

const seedTags = (db: DatabaseSync, pairs: Array<{recordId: string; tag: string}>): void => {
  const seenTags = new Set<string>();
  for (const p of pairs) seenTags.add(p.tag);
  for (const tag of seenTags) {
    db.prepare('INSERT OR IGNORE INTO tags_taxonomy (tag, added) VALUES (?, ?)').run(
      tag,
      '2026-04-29'
    );
  }
  for (const p of pairs) {
    db.prepare('INSERT OR IGNORE INTO tags (record_id, tag) VALUES (?, ?)').run(p.recordId, p.tag);
  }
};

test('GET /tags returns counts envelope', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      const alphaId = await findId(ctx.url, 'topics/alpha.md');
      const betaId = await findId(ctx.url, 'topics/beta.md');
      seedTags(ctx.db, [
        {recordId: alphaId, tag: 'docker'},
        {recordId: alphaId, tag: 'k8s'},
        {recordId: betaId, tag: 'docker'}
      ]);

      const r = await fetchAuthed(`${ctx.url}/tags`);
      t.equal(r.status, 200, '200 ok');
      const env = r.body as {items: Array<{tag: string; record_count: number}>; total: number};
      const docker = env.items.find(i => i.tag === 'docker');
      const k8s = env.items.find(i => i.tag === 'k8s');
      t.equal(docker?.record_count, 2, 'docker has 2 records');
      t.equal(k8s?.record_count, 1, 'k8s has 1 record');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /tags/{tag}/records lists records carrying the tag', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      const alphaId = await findId(ctx.url, 'topics/alpha.md');
      seedTags(ctx.db, [{recordId: alphaId, tag: 'docker'}]);

      const r = await fetchAuthed(`${ctx.url}/tags/docker/records`);
      t.equal(r.status, 200, '200 ok');
      const env = r.body as {items: Array<{file_path: string}>; total: number};
      t.equal(env.total, 1, 'one record');
      t.equal(env.items[0]?.file_path, 'topics/alpha.md', 'returned alpha.md');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /tags/{unknown-tag}/records returns 404', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/tags/nonexistent/records`);
      t.equal(r.status, 404, '404 not found');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

// ─── suggestions ────────────────────────────────────────────────────────────

const seedSuggestion = (
  db: DatabaseSync,
  fields: {id: string; kind: string; subjectId?: string | null; payload?: unknown}
): void => {
  db.prepare(
    `INSERT INTO suggestions (id, kind, subject_id, payload, status, created)
     VALUES (?, ?, ?, ?, 'pending', ?)`
  ).run(
    fields.id,
    fields.kind,
    fields.subjectId ?? null,
    JSON.stringify(fields.payload ?? {}),
    '2026-04-29T00:00:00Z'
  );
};

test('GET /suggestions defaults to status=pending', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      seedSuggestion(ctx.db, {id: 's1', kind: 'edge_type', payload: {note: 'one'}});
      seedSuggestion(ctx.db, {id: 's2', kind: 'duplicate', payload: {note: 'two'}});
      ctx.db
        .prepare(
          `UPDATE suggestions SET status = 'accepted', resolved_at = '2026-04-29' WHERE id = 's2'`
        )
        .run();

      const r = await fetchAuthed(`${ctx.url}/suggestions`);
      t.equal(r.status, 200, '200 ok');
      const env = r.body as {items: Array<{id: string}>; total: number};
      t.equal(env.total, 1, 'only the pending one');
      t.equal(env.items[0]?.id, 's1', 's1 returned');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /suggestions/{id}/accept marks accepted', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      seedSuggestion(ctx.db, {id: 's1', kind: 'edge_type'});
      const r = await fetchAuthed(`${ctx.url}/suggestions/s1/accept`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({resolved_by: 'test-agent'})
      });
      t.equal(r.status, 200, '200 ok');
      const env = r.body as {status: string; resolved_by: string};
      t.equal(env.status, 'accepted', 'status updated');
      t.equal(env.resolved_by, 'test-agent', 'resolved_by recorded');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /suggestions/{id}/reject marks rejected', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      seedSuggestion(ctx.db, {id: 's1', kind: 'edge_type'});
      const r = await fetchAuthed(`${ctx.url}/suggestions/s1/reject`, {method: 'POST'});
      t.equal(r.status, 200, '200 ok');
      t.equal((r.body as {status: string}).status, 'rejected', 'status=rejected');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /suggestions/{id}/accept on already-resolved returns 409', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      seedSuggestion(ctx.db, {id: 's1', kind: 'edge_type'});
      await fetchAuthed(`${ctx.url}/suggestions/s1/accept`, {method: 'POST'});
      const second = await fetchAuthed(`${ctx.url}/suggestions/s1/accept`, {method: 'POST'});
      t.equal(second.status, 409, '409 conflict');
      t.equal((second.body as {code: string}).code, 'already_resolved', 'code=already_resolved');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /suggestions/{unknown}/accept returns 404', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/suggestions/nope/accept`, {method: 'POST'});
      t.equal(r.status, 404, '404 not found');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /suggestions?kind=edge_type filters by kind', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      seedSuggestion(ctx.db, {id: 's1', kind: 'edge_type'});
      seedSuggestion(ctx.db, {id: 's2', kind: 'duplicate'});
      const r = await fetchAuthed(`${ctx.url}/suggestions?kind=edge_type`);
      const env = r.body as {items: Array<{id: string}>; total: number};
      t.equal(env.total, 1, 'only edge_type');
      t.equal(env.items[0]?.id, 's1', 's1 returned');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /suggestions/summary groups pending by kind', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      seedSuggestion(ctx.db, {id: 'a1', kind: 'edge_type'});
      seedSuggestion(ctx.db, {id: 'a2', kind: 'edge_type'});
      seedSuggestion(ctx.db, {id: 'a3', kind: 'edge_type'});
      seedSuggestion(ctx.db, {id: 'b1', kind: 'duplicate'});
      seedSuggestion(ctx.db, {id: 'c1', kind: 'new_tag'});
      // accepted ones must be excluded from the default pending summary
      seedSuggestion(ctx.db, {id: 'z1', kind: 'edge_type'});
      ctx.db
        .prepare(
          `UPDATE suggestions SET status = 'accepted', resolved_at = '2026-04-30' WHERE id = 'z1'`
        )
        .run();

      const r = await fetchAuthed(`${ctx.url}/suggestions/summary`);
      t.equal(r.status, 200, '200 ok');
      const env = r.body as {statuses: string[]; total: number; by_kind: Record<string, number>};
      t.deepEqual(env.statuses, ['pending'], 'default status filter');
      t.equal(env.total, 5, 'total pending excludes accepted');
      t.equal(env.by_kind['edge_type'], 3, 'edge_type=3');
      t.equal(env.by_kind['duplicate'], 1, 'duplicate=1');
      t.equal(env.by_kind['new_tag'], 1, 'new_tag=1');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /suggestions/summary?status=accepted filters status', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      seedSuggestion(ctx.db, {id: 'p1', kind: 'edge_type'});
      seedSuggestion(ctx.db, {id: 'a1', kind: 'duplicate'});
      ctx.db
        .prepare(
          `UPDATE suggestions SET status = 'accepted', resolved_at = '2026-04-30' WHERE id = 'a1'`
        )
        .run();
      const r = await fetchAuthed(`${ctx.url}/suggestions/summary?status=accepted`);
      const env = r.body as {total: number; by_kind: Record<string, number>};
      t.equal(env.total, 1, 'only accepted counted');
      t.equal(env.by_kind['duplicate'], 1, 'duplicate=1');
      t.equal(env.by_kind['edge_type'], undefined, 'no pending edge_type');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('GET /suggestions/summary returns empty by_kind when nothing matches', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      // No suggestions seeded.
      const r = await fetchAuthed(`${ctx.url}/suggestions/summary`);
      t.equal(r.status, 200, '200 ok');
      const env = r.body as {total: number; by_kind: Record<string, number>};
      t.equal(env.total, 0, 'total=0');
      t.deepEqual(env.by_kind, {}, 'empty map');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /suggestions creates a pending suggestion', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/suggestions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          kind: 'contradiction_candidate',
          subject_id: 'rec-1',
          payload: {note: 'A says X, B says not X', a_record: 'rec-1', b_record: 'rec-2'}
        })
      });
      t.equal(r.status, 201, '201 created');
      const created = r.body as {id: string; kind: string; status: string; payload: unknown};
      t.ok(created.id && created.id.length > 0, 'id assigned');
      t.equal(created.kind, 'contradiction_candidate', 'kind echoed');
      t.equal(created.status, 'pending', 'starts pending');
      t.deepEqual(
        created.payload,
        {note: 'A says X, B says not X', a_record: 'rec-1', b_record: 'rec-2'},
        'payload round-tripped'
      );
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /suggestions rejects unknown kind', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/suggestions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({kind: 'bogus_kind', payload: {}})
      });
      t.equal(r.status, 400, '400 bad_request');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /suggestions rejects missing payload', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/suggestions`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({kind: 'contradiction_candidate'})
      });
      t.equal(r.status, 400, '400 bad_request');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /suggestions/{id}/reopen reverts an accepted suggestion to pending', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      seedSuggestion(ctx.db, {id: 's1', kind: 'edge_type'});
      // Accept it.
      const accept = await fetchAuthed(`${ctx.url}/suggestions/s1/accept`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: '{}'
      });
      t.equal(accept.status, 200, 'accept ok');

      const reopen = await fetchAuthed(`${ctx.url}/suggestions/s1/reopen`, {method: 'POST'});
      t.equal(reopen.status, 200, '200 ok');
      const body = reopen.body as {
        status: string;
        resolved_at: string | null;
        resolved_by: string | null;
      };
      t.equal(body.status, 'pending', 'now pending');
      t.equal(body.resolved_at, null, 'resolved_at cleared');
      t.equal(body.resolved_by, null, 'resolved_by cleared');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /suggestions/{id}/reopen on already-pending returns 409', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      seedSuggestion(ctx.db, {id: 's1', kind: 'edge_type'});
      const r = await fetchAuthed(`${ctx.url}/suggestions/s1/reopen`, {method: 'POST'});
      t.equal(r.status, 409, '409 already_pending');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /suggestions/{unknown}/reopen returns 404', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/suggestions/nope/reopen`, {method: 'POST'});
      t.equal(r.status, 404, '404 suggestion_not_found');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

// ─── POST /tags/taxonomy ─────────────────────────────────────────────────────

const seedNewTagSuggestion = (
  db: DatabaseSync,
  args: {id: string; tag: string; recordId: string; filePath: string}
): void => {
  db.prepare(
    `INSERT INTO suggestions (id, kind, subject_id, payload, status, created)
     VALUES (?, 'new_tag', ?, ?, 'pending', ?)`
  ).run(
    args.id,
    args.recordId,
    JSON.stringify({tag: args.tag, record_id: args.recordId, file_path: args.filePath}),
    '2026-04-30T00:00:00.000Z'
  );
};

test('POST /tags/taxonomy adds canonical and auto-resolves pending new_tag suggestions', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      const alphaId = await findId(ctx.url, 'topics/alpha.md');
      seedNewTagSuggestion(ctx.db, {
        id: 'sug1',
        tag: 'machine-learning',
        recordId: alphaId,
        filePath: 'topics/alpha.md'
      });

      const r = await fetchAuthed(`${ctx.url}/tags/taxonomy`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({tag: 'machine-learning', description: 'ML topics'})
      });
      t.equal(r.status, 200);
      const body = r.body as {tag: string; linked: number; accepted: number};
      t.equal(body.tag, 'machine-learning');
      t.equal(body.linked, 1, 'one record linked to the new tag');
      t.equal(body.accepted, 1, 'one suggestion auto-accepted');

      // Tag now in taxonomy.
      const tagRow = ctx.db
        .prepare('SELECT description FROM tags_taxonomy WHERE tag = ?')
        .get('machine-learning') as {description: string} | undefined;
      t.equal(tagRow?.description, 'ML topics', 'description stored');

      // Record carries the tag.
      const linkRow = ctx.db
        .prepare('SELECT 1 AS x FROM tags WHERE record_id = ? AND tag = ?')
        .get(alphaId, 'machine-learning');
      t.ok(linkRow, 'record→tag link established');

      // Suggestion is accepted with resolved_by='taxonomy-add'.
      const sug = ctx.db
        .prepare('SELECT status, resolved_by FROM suggestions WHERE id = ?')
        .get('sug1') as {status: string; resolved_by: string};
      t.equal(sug.status, 'accepted');
      t.equal(sug.resolved_by, 'taxonomy-add');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /tags/taxonomy returns 409 on duplicate', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      ctx.db
        .prepare('INSERT INTO tags_taxonomy (tag, description, added) VALUES (?, ?, ?)')
        .run('design', null, '2026-04-30');
      const r = await fetchAuthed(`${ctx.url}/tags/taxonomy`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({tag: 'design'})
      });
      t.equal(r.status, 409);
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /tags/taxonomy returns 400 on invalid tag shape', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/tags/taxonomy`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({tag: 'Has Spaces'})
      });
      t.equal(r.status, 400);
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

// ─── POST /tags/aliases ──────────────────────────────────────────────────────

test('POST /tags/aliases adds alias, links pending suggestions to canonical', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      ctx.db
        .prepare('INSERT INTO tags_taxonomy (tag, description, added) VALUES (?, ?, ?)')
        .run('machine-learning', null, '2026-04-30');

      const alphaId = await findId(ctx.url, 'topics/alpha.md');
      seedNewTagSuggestion(ctx.db, {
        id: 'sug2',
        tag: 'ml',
        recordId: alphaId,
        filePath: 'topics/alpha.md'
      });

      const r = await fetchAuthed(`${ctx.url}/tags/aliases`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({alias: 'ml', canonical: 'machine-learning'})
      });
      t.equal(r.status, 200);
      const body = r.body as {alias: string; canonical: string; linked: number; accepted: number};
      t.equal(body.linked, 1, 'record linked to the canonical');
      t.equal(body.accepted, 1, 'suggestion auto-accepted');

      // Alias stored.
      const aliasRow = ctx.db
        .prepare('SELECT canonical FROM tag_aliases WHERE alias = ?')
        .get('ml') as {canonical: string};
      t.equal(aliasRow.canonical, 'machine-learning');

      // Record carries the canonical tag (NOT the alias).
      const linkRow = ctx.db
        .prepare('SELECT tag FROM tags WHERE record_id = ?')
        .all(alphaId) as Array<{tag: string}>;
      t.deepEqual(
        linkRow.map(r => r.tag),
        ['machine-learning'],
        'canonical tag linked'
      );

      const sug = ctx.db
        .prepare('SELECT status, resolved_by FROM suggestions WHERE id = ?')
        .get('sug2') as {status: string; resolved_by: string};
      t.equal(sug.resolved_by, 'alias-add');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /tags/aliases returns 404 if canonical missing', async t => {
  const {root, cleanup} = setup();
  try {
    seedGraph(root);
    const ctx = await startTestServer(root);
    try {
      const r = await fetchAuthed(`${ctx.url}/tags/aliases`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({alias: 'foo', canonical: 'does-not-exist'})
      });
      t.equal(r.status, 404);
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});
