import test from 'tape-six';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-lint';

const makeEnv = (port: number): ServerEnv => ({
  vaultDataPath: '/tmp/vault-storage-lint-test-data',
  vaultIngestPath: null,
  vaultDbPath: ':memory:',
  apiToken: TEST_TOKEN,
  host: '127.0.0.1',
  port,
  autoReindex: false,
  autoWatch: false,
  watchDebounceMs: 1500,
  embedder: 'fake',
  autoCommit: false,
  autoPush: false,
  commitIntervalMs: 60000,
  gitAuthorName: 'vault-storage',
  gitAuthorEmail: 'vault-storage@localhost',
  uiStaticPath: ''
});

const fetchJson = async (
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

const withServer = async (
  fn: (url: string, db: DatabaseSync) => Promise<void>
): Promise<void> => {
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  const handle = await startServer({
    db,
    env: makeEnv(0),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const url = `http://127.0.0.1:${port}`;
  try {
    await fn(url, db);
  } finally {
    await handle.close();
    db.close();
  }
};

const insertRecord = (
  db: DatabaseSync,
  fields: {
    record_id: string;
    file_path: string;
    type?: string;
    body?: string;
    content_hash?: string;
    created?: string;
    updated?: string;
  }
): void => {
  db.prepare(
    `INSERT INTO records
       (record_id, file_path, type, body, content_hash, created, updated)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    fields.record_id,
    fields.file_path,
    fields.type ?? 'permanent',
    fields.body ?? 'body',
    fields.content_hash ?? 'hash-fresh',
    fields.created ?? '2026-04-29',
    fields.updated ?? '2026-04-29'
  );
};

const insertVecChunk = (
  db: DatabaseSync,
  chunk: {chunk_id: string; record_id: string; content_hash: string}
): void => {
  // Fake 384-dim embedding (all zeros) for testing.
  const embedding = new Float32Array(384);
  db.prepare(
    `INSERT INTO record_vec (chunk_id, record_id, chunk_index, content_hash, embedding)
     VALUES (?, ?, 0, ?, ?)`
  ).run(chunk.chunk_id, chunk.record_id, chunk.content_hash, embedding);
};

test('GET /system/lint on empty DB: ok=true, all checks 0', async t => {
  await withServer(async url => {
    const {status, body} = await fetchJson(`${url}/system/lint`);
    t.equal(status, 200, '200 ok');
    const r = body as {
      ok: boolean;
      total_issues: number;
      checks: Record<string, {count: number; samples: unknown[]}>;
    };
    t.equal(r.ok, true, 'ok=true');
    t.equal(r.total_issues, 0, 'total_issues=0');
    const expectedChecks = [
      'embedding_hash_drift',
      'records_without_embeddings',
      'orphan_embeddings',
      'temporal_anomalies',
      'dangling_tag_aliases'
    ];
    for (const name of expectedChecks) {
      t.equal(r.checks[name]?.count, 0, `${name}.count=0`);
      t.equal(r.checks[name]?.samples.length, 0, `${name}.samples=[]`);
    }
  });
});

test('GET /system/lint detects embedding_hash_drift', async t => {
  await withServer(async (url, db) => {
    insertRecord(db, {
      record_id: 'rec-drift',
      file_path: 'topics/drift.md',
      content_hash: 'hash-NEW'
    });
    insertVecChunk(db, {
      chunk_id: 'chunk-drift-0',
      record_id: 'rec-drift',
      content_hash: 'hash-OLD' // drift
    });

    const {body} = await fetchJson(`${url}/system/lint`);
    const r = body as {ok: boolean; checks: Record<string, {count: number; samples: {id: string; file_path: string}[]}>};
    t.equal(r.ok, false, 'ok=false');
    t.equal(r.checks['embedding_hash_drift']?.count, 1, 'drift count=1');
    t.equal(r.checks['embedding_hash_drift']?.samples[0]?.id, 'rec-drift', 'sample id=rec-drift');
    t.equal(r.checks['embedding_hash_drift']?.samples[0]?.file_path, 'topics/drift.md', 'sample file_path');
    t.equal(r.checks['records_without_embeddings']?.count, 0, 'no records-without-embeddings (chunk exists)');
  });
});

test('GET /system/lint detects records_without_embeddings', async t => {
  await withServer(async (url, db) => {
    insertRecord(db, {record_id: 'rec-noemb', file_path: 'topics/noemb.md'});
    // No vec chunk for rec-noemb.

    const {body} = await fetchJson(`${url}/system/lint`);
    const r = body as {ok: boolean; checks: Record<string, {count: number; samples: {id: string}[]}>};
    t.equal(r.ok, false, 'ok=false');
    t.equal(r.checks['records_without_embeddings']?.count, 1, 'count=1');
    t.equal(r.checks['records_without_embeddings']?.samples[0]?.id, 'rec-noemb', 'sample id');
  });
});

test('GET /system/lint detects orphan_embeddings', async t => {
  await withServer(async (url, db) => {
    // Insert a vec chunk with no matching record.
    insertVecChunk(db, {
      chunk_id: 'chunk-orphan-0',
      record_id: 'rec-ghost',
      content_hash: 'hash-anything'
    });

    const {body} = await fetchJson(`${url}/system/lint`);
    const r = body as {ok: boolean; checks: Record<string, {count: number; samples: {id: string}[]}>};
    t.equal(r.ok, false, 'ok=false');
    t.equal(r.checks['orphan_embeddings']?.count, 1, 'count=1');
    t.equal(r.checks['orphan_embeddings']?.samples[0]?.id, 'rec-ghost', 'sample id');
  });
});

test('GET /system/lint detects temporal_anomalies (updated < created)', async t => {
  await withServer(async (url, db) => {
    insertRecord(db, {
      record_id: 'rec-temporal',
      file_path: 'topics/temporal.md',
      created: '2026-04-29',
      updated: '2026-04-01' // backwards
    });
    insertVecChunk(db, {
      chunk_id: 'chunk-temporal-0',
      record_id: 'rec-temporal',
      content_hash: 'hash-fresh'
    });

    const {body} = await fetchJson(`${url}/system/lint`);
    const r = body as {ok: boolean; checks: Record<string, {count: number; samples: {id: string}[]}>};
    t.equal(r.ok, false, 'ok=false');
    t.equal(r.checks['temporal_anomalies']?.count, 1, 'count=1');
    t.equal(r.checks['temporal_anomalies']?.samples[0]?.id, 'rec-temporal', 'sample id');
  });
});

test('GET /system/lint detects temporal_anomalies (future stamps)', async t => {
  await withServer(async (url, db) => {
    insertRecord(db, {
      record_id: 'rec-future',
      file_path: 'topics/future.md',
      created: '2099-01-01',
      updated: '2099-01-01'
    });
    insertVecChunk(db, {
      chunk_id: 'chunk-future-0',
      record_id: 'rec-future',
      content_hash: 'hash-fresh'
    });

    const {body} = await fetchJson(`${url}/system/lint`);
    const r = body as {ok: boolean; checks: Record<string, {count: number}>};
    t.equal(r.ok, false, 'ok=false');
    t.equal(r.checks['temporal_anomalies']?.count, 1, 'future stamp counted');
  });
});

test('GET /system/lint detects dangling_tag_aliases', async t => {
  await withServer(async (url, db) => {
    // Bypass the FK by disabling foreign_keys for this insert. Simulates a
    // PRAGMA-off write or schema drift.
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      `INSERT INTO tag_aliases (alias, canonical) VALUES (?, ?)`
    ).run('rusts-lang', 'rust-lang-not-in-taxonomy');
    db.exec('PRAGMA foreign_keys = ON');

    const {body} = await fetchJson(`${url}/system/lint`);
    const r = body as {ok: boolean; checks: Record<string, {count: number; samples: {id: string; canonical: string}[]}>};
    t.equal(r.ok, false, 'ok=false');
    t.equal(r.checks['dangling_tag_aliases']?.count, 1, 'count=1');
    t.equal(r.checks['dangling_tag_aliases']?.samples[0]?.id, 'rusts-lang', 'sample alias');
    t.equal(r.checks['dangling_tag_aliases']?.samples[0]?.canonical, 'rust-lang-not-in-taxonomy', 'sample canonical');
  });
});

test('GET /system/lint clean DB after a healthy record + chunk: ok=true', async t => {
  await withServer(async (url, db) => {
    insertRecord(db, {
      record_id: 'rec-good',
      file_path: 'topics/good.md',
      content_hash: 'hash-match'
    });
    insertVecChunk(db, {
      chunk_id: 'chunk-good-0',
      record_id: 'rec-good',
      content_hash: 'hash-match'
    });

    const {body} = await fetchJson(`${url}/system/lint`);
    const r = body as {ok: boolean; total_issues: number};
    t.equal(r.ok, true, 'ok=true');
    t.equal(r.total_issues, 0, 'no issues');
  });
});

test('GET /system/lint caps samples at 10 per check', async t => {
  await withServer(async (url, db) => {
    // 15 records with no embeddings.
    for (let i = 0; i < 15; i++) {
      insertRecord(db, {
        record_id: `rec-noemb-${i}`,
        file_path: `topics/noemb-${i}.md`
      });
    }

    const {body} = await fetchJson(`${url}/system/lint`);
    const r = body as {checks: Record<string, {count: number; samples: unknown[]}>};
    t.equal(r.checks['records_without_embeddings']?.count, 15, 'count reflects all 15');
    t.equal(r.checks['records_without_embeddings']?.samples.length, 10, 'samples capped at 10');
  });
});
