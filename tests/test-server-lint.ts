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

const withServer = async (fn: (url: string, db: DatabaseSync) => Promise<void>): Promise<void> => {
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
       (record_id, file_path, type, body, content_hash, body_hash, created, updated)
     VALUES (?, ?, ?, ?, ?, '', ?, ?)`
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
  db.prepare(
    `INSERT INTO chunks (chunk_id, record_id, chunk_index, content_hash)
     VALUES (?, ?, 0, ?)`
  ).run(chunk.chunk_id, chunk.record_id, chunk.content_hash);
  // Fake 384-dim embedding (all zeros) for testing.
  const embedding = new Float32Array(384);
  db.prepare('INSERT INTO record_vec (chunk_id, embedding) VALUES (?, ?)').run(
    chunk.chunk_id,
    embedding
  );
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
      'orphan_vec_rows',
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
    const r = body as {
      ok: boolean;
      checks: Record<string, {count: number; samples: {id: string; file_path: string}[]}>;
    };
    t.equal(r.ok, false, 'ok=false');
    t.equal(r.checks['embedding_hash_drift']?.count, 1, 'drift count=1');
    t.equal(r.checks['embedding_hash_drift']?.samples[0]?.id, 'rec-drift', 'sample id=rec-drift');
    t.equal(
      r.checks['embedding_hash_drift']?.samples[0]?.file_path,
      'topics/drift.md',
      'sample file_path'
    );
    t.equal(
      r.checks['records_without_embeddings']?.count,
      0,
      'no records-without-embeddings (chunk exists)'
    );
  });
});

test('GET /system/lint detects records_without_embeddings', async t => {
  await withServer(async (url, db) => {
    insertRecord(db, {record_id: 'rec-noemb', file_path: 'topics/noemb.md'});
    // No vec chunk for rec-noemb.

    const {body} = await fetchJson(`${url}/system/lint`);
    const r = body as {
      ok: boolean;
      checks: Record<string, {count: number; samples: {id: string}[]}>;
    };
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
    const r = body as {
      ok: boolean;
      checks: Record<string, {count: number; samples: {id: string}[]}>;
    };
    t.equal(r.ok, false, 'ok=false');
    t.equal(r.checks['orphan_embeddings']?.count, 1, 'count=1');
    t.equal(r.checks['orphan_embeddings']?.samples[0]?.id, 'rec-ghost', 'sample id');
  });
});

test('GET /system/lint detects orphan_doc_embeddings', async t => {
  await withServer(async (url, db) => {
    db.prepare(
      `INSERT INTO record_doc_vec (record_id, content_hash, embedding)
       VALUES (?, ?, ?)`
    ).run('rec-doc-ghost', 'h', new Float32Array(384));

    const {body} = await fetchJson(`${url}/system/lint`);
    const r = body as {
      ok: boolean;
      checks: Record<string, {count: number; samples: {id: string}[]}>;
    };
    t.equal(r.ok, false, 'ok=false');
    t.equal(r.checks['orphan_doc_embeddings']?.count, 1, 'count=1');
    t.equal(r.checks['orphan_doc_embeddings']?.samples[0]?.id, 'rec-doc-ghost', 'sample id');
  });
});

test('GET /system/lint detects orphan_vec_rows (embedding without chunks metadata)', async t => {
  await withServer(async (url, db) => {
    // A record_vec row with no chunks row — the 0010 split's divergence class.
    db.prepare('INSERT INTO record_vec (chunk_id, embedding) VALUES (?, ?)').run(
      'chunk-stray-0',
      new Float32Array(384)
    );

    const {body} = await fetchJson(`${url}/system/lint`);
    const r = body as {
      ok: boolean;
      checks: Record<string, {count: number; samples: {id: string}[]}>;
    };
    t.equal(r.ok, false, 'ok=false');
    t.equal(r.checks['orphan_vec_rows']?.count, 1, 'count=1');
    t.equal(r.checks['orphan_vec_rows']?.samples[0]?.id, 'chunk-stray-0', 'sample id');
  });
});

test('records_after_delete trigger cascades to chunks, record_vec, and record_doc_vec', async t => {
  await withServer(async (_url, db) => {
    insertRecord(db, {record_id: 'rec-cascade', file_path: 'topics/cascade.md', content_hash: 'h'});
    insertVecChunk(db, {chunk_id: 'c-cascade-0', record_id: 'rec-cascade', content_hash: 'h'});
    insertVecChunk(db, {chunk_id: 'c-cascade-1', record_id: 'rec-cascade', content_hash: 'h'});
    db.prepare(
      `INSERT INTO record_doc_vec (record_id, content_hash, embedding)
       VALUES (?, ?, ?)`
    ).run('rec-cascade', 'h', new Float32Array(384));

    db.prepare('DELETE FROM records WHERE record_id = ?').run('rec-cascade');

    const meta = db
      .prepare('SELECT COUNT(*) AS n FROM chunks WHERE record_id = ?')
      .get('rec-cascade') as {n: number};
    t.equal(meta.n, 0, 'chunks rows cascaded');
    const vecs = db
      .prepare(`SELECT COUNT(*) AS n FROM record_vec WHERE chunk_id IN (?, ?)`)
      .get('c-cascade-0', 'c-cascade-1') as {n: number};
    t.equal(vecs.n, 0, 'record_vec rows cascaded');
    const docs = db
      .prepare('SELECT COUNT(*) AS n FROM record_doc_vec WHERE record_id = ?')
      .get('rec-cascade') as {n: number};
    t.equal(docs.n, 0, 'record_doc_vec row cascaded');
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
    const r = body as {
      ok: boolean;
      checks: Record<string, {count: number; samples: {id: string}[]}>;
    };
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
    db.prepare(`INSERT INTO tag_aliases (alias, canonical) VALUES (?, ?)`).run(
      'rusts-lang',
      'rust-lang-not-in-taxonomy'
    );
    db.exec('PRAGMA foreign_keys = ON');

    const {body} = await fetchJson(`${url}/system/lint`);
    const r = body as {
      ok: boolean;
      checks: Record<string, {count: number; samples: {id: string; canonical: string}[]}>;
    };
    t.equal(r.ok, false, 'ok=false');
    t.equal(r.checks['dangling_tag_aliases']?.count, 1, 'count=1');
    t.equal(r.checks['dangling_tag_aliases']?.samples[0]?.id, 'rusts-lang', 'sample alias');
    t.equal(
      r.checks['dangling_tag_aliases']?.samples[0]?.canonical,
      'rust-lang-not-in-taxonomy',
      'sample canonical'
    );
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

test('POST /maintenance/cleanup-lint deletes orphan embeddings', async t => {
  await withServer(async (url, db) => {
    insertRecord(db, {
      record_id: 'rec-good',
      file_path: 'topics/good.md',
      content_hash: 'hash-match'
    });
    insertVecChunk(db, {chunk_id: 'c-good-0', record_id: 'rec-good', content_hash: 'hash-match'});
    insertVecChunk(db, {chunk_id: 'c-orphan1-0', record_id: 'rec-orphan1', content_hash: 'hash-x'});
    insertVecChunk(db, {chunk_id: 'c-orphan2-0', record_id: 'rec-orphan2', content_hash: 'hash-x'});
    insertVecChunk(db, {chunk_id: 'c-orphan2-1', record_id: 'rec-orphan2', content_hash: 'hash-x'});

    const before = await fetchJson(`${url}/system/lint`);
    t.equal(
      (before.body as {checks: {orphan_embeddings: {count: number}}}).checks.orphan_embeddings
        .count,
      2,
      'pre: 2 orphan record_ids'
    );

    const {status, body} = await fetchJson(`${url}/maintenance/cleanup-lint`, {method: 'POST'});
    t.equal(status, 200, '200 ok');
    const r = body as {
      totalFixed: number;
      fixed: {orphan_embeddings: {recordsAffected: number; chunksDeleted: number}};
      needsReview: Record<string, number>;
    };
    t.equal(r.totalFixed, 2, 'totalFixed=2 record_ids');
    t.equal(r.fixed.orphan_embeddings.recordsAffected, 2, 'recordsAffected=2');
    t.equal(r.fixed.orphan_embeddings.chunksDeleted, 3, 'chunksDeleted=3 (1 + 2)');

    const after = await fetchJson(`${url}/system/lint`);
    t.equal((after.body as {ok: boolean}).ok, true, 'lint clean after cleanup');

    const remaining = db.prepare('SELECT chunk_id FROM record_vec ORDER BY chunk_id').all() as {
      chunk_id: string;
    }[];
    t.equal(remaining.length, 1, 'one healthy chunk preserved');
    t.equal(remaining[0]?.chunk_id, 'c-good-0', 'healthy chunk untouched');
    const metaRemaining = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as {n: number};
    t.equal(metaRemaining.n, 1, 'orphan chunks metadata rows deleted too');
  });
});

test('POST /maintenance/cleanup-lint deletes orphan_vec_rows (embedding without metadata)', async t => {
  await withServer(async (url, db) => {
    insertRecord(db, {
      record_id: 'rec-good',
      file_path: 'topics/good.md',
      content_hash: 'hash-match'
    });
    insertVecChunk(db, {chunk_id: 'c-good-0', record_id: 'rec-good', content_hash: 'hash-match'});
    // Stray embedding with no chunks metadata row.
    db.prepare('INSERT INTO record_vec (chunk_id, embedding) VALUES (?, ?)').run(
      'c-stray-0',
      new Float32Array(384)
    );

    const {status, body} = await fetchJson(`${url}/maintenance/cleanup-lint`, {method: 'POST'});
    t.equal(status, 200, '200 ok');
    const r = body as {
      totalFixed: number;
      fixed: {orphan_vec_rows: {rowsDeleted: number}};
    };
    t.equal(r.totalFixed, 1, 'totalFixed=1');
    t.equal(r.fixed.orphan_vec_rows.rowsDeleted, 1, 'stray vec row deleted');

    const after = await fetchJson(`${url}/system/lint`);
    t.equal((after.body as {ok: boolean}).ok, true, 'lint clean after cleanup');

    const remaining = db.prepare('SELECT chunk_id FROM record_vec ORDER BY chunk_id').all() as {
      chunk_id: string;
    }[];
    t.equal(remaining.length, 1, 'healthy chunk preserved');
    t.equal(remaining[0]?.chunk_id, 'c-good-0', 'healthy chunk untouched');
  });
});

test('POST /maintenance/cleanup-lint is a no-op on a clean DB', async t => {
  await withServer(async (url, db) => {
    insertRecord(db, {
      record_id: 'rec-good',
      file_path: 'topics/good.md',
      content_hash: 'hash-match'
    });
    insertVecChunk(db, {chunk_id: 'c-good-0', record_id: 'rec-good', content_hash: 'hash-match'});

    const {status, body} = await fetchJson(`${url}/maintenance/cleanup-lint`, {method: 'POST'});
    t.equal(status, 200, '200 ok');
    const r = body as {totalFixed: number; fixed: {orphan_embeddings: {recordsAffected: number}}};
    t.equal(r.totalFixed, 0, 'nothing to fix');
    t.equal(r.fixed.orphan_embeddings.recordsAffected, 0, 'no orphans');
  });
});

test('POST /maintenance/cleanup-lint resolves orphan_suggestions (subject record missing)', async t => {
  await withServer(async (url, db) => {
    // Three pending suggestions: one whose subject is a live record (s-live),
    // one whose subject is a missing record (s-orphan), and one with NULL
    // subject (s-system, a system-level kind). Plus one already-rejected
    // orphan (s-resolved) — verify cleanup-lint touches only s-orphan.
    insertRecord(db, {record_id: 'rec-live', file_path: 'topics/live.md', content_hash: 'h'});
    insertVecChunk(db, {chunk_id: 'c-live-0', record_id: 'rec-live', content_hash: 'h'});
    const insertSugg = db.prepare(
      `INSERT INTO suggestions (id, kind, subject_id, payload, status, created)
       VALUES (?, ?, ?, '{}', ?, '2026-01-01')`
    );
    insertSugg.run('s-live', 'archive_candidate', 'rec-live', 'pending');
    insertSugg.run('s-orphan', 'archive_candidate', 'rec-missing', 'pending');
    insertSugg.run('s-system', 'inefficiency_detected', null, 'pending');
    insertSugg.run('s-resolved', 'edge_type', 'rec-missing', 'rejected');

    const before = await fetchJson(`${url}/system/lint`);
    t.equal(
      (before.body as {checks: {orphan_suggestions: {count: number}}}).checks.orphan_suggestions
        .count,
      1,
      'pre: 1 orphan_suggestion'
    );

    const {status, body} = await fetchJson(`${url}/maintenance/cleanup-lint`, {method: 'POST'});
    t.equal(status, 200, '200 ok');
    const r = body as {
      totalFixed: number;
      fixed: {orphan_suggestions: {suggestionsResolved: number}};
    };
    t.equal(r.fixed.orphan_suggestions.suggestionsResolved, 1, 'resolved 1 orphan');

    const rows = db
      .prepare('SELECT id, status, resolved_by FROM suggestions ORDER BY id')
      .all() as {id: string; status: string; resolved_by: string | null}[];
    const byId = Object.fromEntries(rows.map(row => [row.id, row]));
    t.equal(byId['s-orphan']?.status, 'accepted', 's-orphan → accepted');
    t.equal(
      byId['s-orphan']?.resolved_by,
      'record-deleted-backfill',
      's-orphan carries the backfill marker'
    );
    t.equal(byId['s-live']?.status, 'pending', 's-live (live subject) untouched');
    t.equal(byId['s-system']?.status, 'pending', 's-system (NULL subject) untouched');
    t.equal(byId['s-resolved']?.status, 'rejected', 's-resolved (already-resolved) untouched');
  });
});

test('POST /maintenance/cleanup-lint reports needsReview counts for non-fixable categories', async t => {
  await withServer(async (url, db) => {
    insertRecord(db, {
      record_id: 'rec-temporal',
      file_path: 'topics/temporal.md',
      created: '2026-04-29',
      updated: '2026-04-01'
    });
    insertVecChunk(db, {
      chunk_id: 'c-temporal-0',
      record_id: 'rec-temporal',
      content_hash: 'hash-fresh'
    });

    const {body} = await fetchJson(`${url}/maintenance/cleanup-lint`, {method: 'POST'});
    const r = body as {totalFixed: number; needsReview: Record<string, number>};
    t.equal(r.totalFixed, 0, 'no orphans to fix');
    t.equal(r.needsReview['temporal_anomalies'], 1, 'temporal anomaly surfaced for review');
    t.equal(
      r.needsReview['orphan_embeddings'],
      undefined,
      'orphan_embeddings is in fixed, not needsReview'
    );
  });
});

test('POST /maintenance/cleanup-lint clamps future-dated created stamp to now', async t => {
  await withServer(async (url, db) => {
    insertRecord(db, {
      record_id: 'rec-future-c',
      file_path: 'topics/future-c.md',
      created: '2099-01-01',
      updated: '2026-04-15'
    });
    insertVecChunk(db, {chunk_id: 'c-future-c-0', record_id: 'rec-future-c', content_hash: 'h'});

    const {status, body} = await fetchJson(`${url}/maintenance/cleanup-lint`, {method: 'POST'});
    t.equal(status, 200, '200 ok');
    const r = body as {
      totalFixed: number;
      fixed: {temporal_future_clamps: {recordsAffected: number; fieldsUpdated: number}};
    };
    t.equal(r.fixed.temporal_future_clamps.recordsAffected, 1, '1 record clamped');
    t.equal(r.fixed.temporal_future_clamps.fieldsUpdated, 1, '1 field updated (created only)');
    t.equal(r.totalFixed, 1, 'totalFixed includes the clamp');

    const after = db
      .prepare('SELECT created, updated FROM records WHERE record_id = ?')
      .get('rec-future-c') as {created: string; updated: string};
    t.ok(after.created <= new Date().toISOString(), 'created clamped to <= now');
    t.equal(after.updated, '2026-04-15', 'updated untouched (was already past)');
  });
});

test('POST /maintenance/cleanup-lint clamps future-dated updated stamp to now', async t => {
  await withServer(async (url, db) => {
    insertRecord(db, {
      record_id: 'rec-future-u',
      file_path: 'topics/future-u.md',
      created: '2026-04-01',
      updated: '2099-12-31'
    });
    insertVecChunk(db, {chunk_id: 'c-future-u-0', record_id: 'rec-future-u', content_hash: 'h'});

    const {body} = await fetchJson(`${url}/maintenance/cleanup-lint`, {method: 'POST'});
    const r = body as {
      fixed: {temporal_future_clamps: {recordsAffected: number; fieldsUpdated: number}};
    };
    t.equal(r.fixed.temporal_future_clamps.recordsAffected, 1, '1 record clamped');
    t.equal(r.fixed.temporal_future_clamps.fieldsUpdated, 1, '1 field updated (updated only)');

    const after = db
      .prepare('SELECT created, updated FROM records WHERE record_id = ?')
      .get('rec-future-u') as {created: string; updated: string};
    t.equal(after.created, '2026-04-01', 'created untouched');
    t.ok(after.updated <= new Date().toISOString(), 'updated clamped to <= now');
  });
});

test('POST /maintenance/cleanup-lint clamps both stamps when both are in the future', async t => {
  await withServer(async (url, db) => {
    insertRecord(db, {
      record_id: 'rec-future-both',
      file_path: 'topics/future-both.md',
      created: '2099-01-01',
      updated: '2099-06-15'
    });
    insertVecChunk(db, {
      chunk_id: 'c-future-both-0',
      record_id: 'rec-future-both',
      content_hash: 'h'
    });

    const {body} = await fetchJson(`${url}/maintenance/cleanup-lint`, {method: 'POST'});
    const r = body as {
      fixed: {temporal_future_clamps: {recordsAffected: number; fieldsUpdated: number}};
    };
    t.equal(r.fixed.temporal_future_clamps.recordsAffected, 1, '1 record clamped');
    t.equal(r.fixed.temporal_future_clamps.fieldsUpdated, 2, '2 fields updated (both)');
  });
});

test('POST /maintenance/cleanup-lint leaves updated < created in needsReview', async t => {
  await withServer(async (url, db) => {
    insertRecord(db, {
      record_id: 'rec-backwards',
      file_path: 'topics/backwards.md',
      created: '2026-04-29',
      updated: '2026-04-01'
    });
    insertVecChunk(db, {chunk_id: 'c-backwards-0', record_id: 'rec-backwards', content_hash: 'h'});

    const {body} = await fetchJson(`${url}/maintenance/cleanup-lint`, {method: 'POST'});
    const r = body as {
      fixed: {temporal_future_clamps: {recordsAffected: number}};
      needsReview: Record<string, number>;
    };
    t.equal(r.fixed.temporal_future_clamps.recordsAffected, 0, 'not a future-clamp case');
    t.equal(r.needsReview['temporal_anomalies'], 1, 'updated<created surfaces for review');

    const after = db
      .prepare('SELECT created, updated FROM records WHERE record_id = ?')
      .get('rec-backwards') as {created: string; updated: string};
    t.equal(after.created, '2026-04-29', 'created untouched');
    t.equal(after.updated, '2026-04-01', 'updated untouched');
  });
});

test('POST /maintenance/cleanup-tag-aliases deletes dangling aliases', async t => {
  await withServer(async (url, db) => {
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(`INSERT INTO tag_aliases (alias, canonical) VALUES (?, ?)`).run(
      'rusts-lang',
      'rust-lang-not-in-taxonomy'
    );
    db.exec('PRAGMA foreign_keys = ON');

    const {status, body} = await fetchJson(`${url}/maintenance/cleanup-tag-aliases`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({aliases: ['rusts-lang']})
    });
    t.equal(status, 200, '200 ok');
    const r = body as {
      requested: number;
      deleted: string[];
      missing: string[];
      notDangling: string[];
    };
    t.equal(r.requested, 1, '1 alias requested');
    t.deepEqual(r.deleted, ['rusts-lang'], 'alias deleted');
    t.equal(r.missing.length, 0, 'none missing');
    t.equal(r.notDangling.length, 0, 'none notDangling');

    const remaining = db.prepare('SELECT alias FROM tag_aliases WHERE alias = ?').get('rusts-lang');
    t.equal(remaining, undefined, 'alias row removed');
  });
});

test('POST /maintenance/cleanup-tag-aliases reports missing for unknown alias', async t => {
  await withServer(async url => {
    const {body} = await fetchJson(`${url}/maintenance/cleanup-tag-aliases`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({aliases: ['no-such-alias']})
    });
    const r = body as {deleted: string[]; missing: string[]; notDangling: string[]};
    t.equal(r.deleted.length, 0, 'nothing deleted');
    t.deepEqual(r.missing, ['no-such-alias'], 'unknown alias surfaces as missing');
    t.equal(r.notDangling.length, 0, 'none notDangling');
  });
});

test('POST /maintenance/cleanup-tag-aliases preserves live aliases (notDangling)', async t => {
  await withServer(async (url, db) => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO tags_taxonomy (tag, description, added) VALUES (?, ?, ?)').run(
      'javascript',
      null,
      now
    );
    db.prepare('INSERT INTO tag_aliases (alias, canonical) VALUES (?, ?)').run('js', 'javascript');

    const {body} = await fetchJson(`${url}/maintenance/cleanup-tag-aliases`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({aliases: ['js']})
    });
    const r = body as {deleted: string[]; missing: string[]; notDangling: string[]};
    t.equal(r.deleted.length, 0, 'nothing deleted');
    t.deepEqual(r.notDangling, ['js'], 'live alias surfaces as notDangling');

    const remaining = db.prepare('SELECT canonical FROM tag_aliases WHERE alias = ?').get('js') as {
      canonical: string;
    };
    t.equal(remaining.canonical, 'javascript', 'live alias preserved');
  });
});

test('POST /maintenance/cleanup-tag-aliases sorts mixed input into the three buckets', async t => {
  await withServer(async (url, db) => {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO tags_taxonomy (tag, description, added) VALUES (?, ?, ?)').run(
      'python',
      null,
      now
    );
    db.prepare('INSERT INTO tag_aliases (alias, canonical) VALUES (?, ?)').run('py', 'python');
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('INSERT INTO tag_aliases (alias, canonical) VALUES (?, ?)').run(
      'ghosted',
      'tag-that-does-not-exist'
    );
    db.exec('PRAGMA foreign_keys = ON');

    const {body} = await fetchJson(`${url}/maintenance/cleanup-tag-aliases`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({aliases: ['ghosted', 'py', 'never-was']})
    });
    const r = body as {
      requested: number;
      deleted: string[];
      missing: string[];
      notDangling: string[];
    };
    t.equal(r.requested, 3, '3 requested');
    t.deepEqual(r.deleted, ['ghosted'], 'dangling alias deleted');
    t.deepEqual(r.notDangling, ['py'], 'live alias preserved');
    t.deepEqual(r.missing, ['never-was'], 'unknown surfaces as missing');
  });
});

test('POST /maintenance/cleanup-tag-aliases returns 400 on missing aliases body', async t => {
  await withServer(async url => {
    const {status, body} = await fetchJson(`${url}/maintenance/cleanup-tag-aliases`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({})
    });
    t.equal(status, 400, '400 bad request');
    t.equal((body as {code: string}).code, 'bad_request', 'bad_request error');
  });
});

test('POST /maintenance/cleanup-tag-aliases returns 400 on non-array aliases', async t => {
  await withServer(async url => {
    const {status} = await fetchJson(`${url}/maintenance/cleanup-tag-aliases`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({aliases: 'js'})
    });
    t.equal(status, 400, '400 bad request');
  });
});

test('POST /maintenance/cleanup-tag-aliases returns 400 on empty body', async t => {
  await withServer(async url => {
    const {status} = await fetchJson(`${url}/maintenance/cleanup-tag-aliases`, {method: 'POST'});
    t.equal(status, 400, '400 bad request');
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

test('POST /maintenance/embed-pending re-embeds records without embeddings', async t => {
  await withServer(async (url, db) => {
    insertRecord(db, {
      record_id: 'rec-pending-1',
      file_path: 'topics/pending-1.md',
      body: 'pending body 1',
      content_hash: 'hash-pending-1'
    });
    insertRecord(db, {
      record_id: 'rec-pending-2',
      file_path: 'topics/pending-2.md',
      body: 'pending body 2',
      content_hash: 'hash-pending-2'
    });

    const {status, body} = await fetchJson(`${url}/maintenance/embed-pending`, {method: 'POST'});
    t.equal(status, 200);
    const summary = body as {embedded: number; total: number};
    t.equal(summary.embedded, 2, 'both records embedded');
    t.equal(summary.total, 2);

    // Idempotent: a second call has nothing pending.
    const second = await fetchJson(`${url}/maintenance/embed-pending`, {method: 'POST'});
    const s2 = second.body as {embedded: number};
    t.equal(s2.embedded, 0, 'no work on second pass');
  });
});

test('POST /maintenance/embed-pending parallel calls do not double-embed', async t => {
  await withServer(async (url, db) => {
    insertRecord(db, {
      record_id: 'rec-parallel',
      file_path: 'topics/parallel.md',
      body: 'body',
      content_hash: 'h'
    });

    // With FakeEmbedder the pass is fast; the two calls may or may not
    // actually coalesce. Either way the record is embedded exactly once:
    // one call sees pending=1 and embeds; the other sees pending=0.
    const [a, b] = await Promise.all([
      fetchJson(`${url}/maintenance/embed-pending`, {method: 'POST'}),
      fetchJson(`${url}/maintenance/embed-pending`, {method: 'POST'})
    ]);
    t.equal(a.status, 200);
    t.equal(b.status, 200);
    const sumA = (a.body as {embedded: number}).embedded;
    const sumB = (b.body as {embedded: number}).embedded;
    t.equal(sumA + sumB, 1, 'one call embeds; the other observes nothing pending');
  });
});

test('GET /system/lint detects auto_commit_failing from the git-sync meta streak', async t => {
  await withServer(async (url, db) => {
    const upsert = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    // Below threshold: a short streak is transient noise.
    upsert.run('git_sync_consecutive_failures', '2');
    upsert.run('git_sync_last_error', "git add failed: fatal: Unable to create '.git/index.lock': File exists.");
    upsert.run('git_sync_failing_since', '2026-06-08T04:14:00.000Z');
    let {body} = await fetchJson(`${url}/system/lint`);
    let report = body as {
      ok: boolean;
      checks: Record<string, {count: number; samples: Array<Record<string, unknown>>}>;
    };
    t.equal(report.checks['auto_commit_failing']?.count, 0, 'streak of 2 stays quiet');
    t.ok(report.ok, 'ok stays true below threshold');

    upsert.run('git_sync_consecutive_failures', '3');
    ({body} = await fetchJson(`${url}/system/lint`));
    report = body as typeof report;
    t.equal(report.checks['auto_commit_failing']?.count, 1, 'streak of 3 fires');
    t.notOk(report.ok, 'ok flips false');
    const sample = report.checks['auto_commit_failing']?.samples[0];
    t.equal(sample?.['consecutive_failures'], 3, 'sample carries the streak');
    t.equal(sample?.['failing_since'], '2026-06-08T04:14:00.000Z', 'sample carries the streak start');
    t.ok(String(sample?.['last_error']).includes('index.lock'), 'sample carries the last error');
  });
});
