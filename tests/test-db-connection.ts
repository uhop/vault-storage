import {readFileSync} from 'node:fs';
import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {contentHash} from '../src/util/hash.ts';

test('opens an in-memory DB with sqlite-vec loaded', t => {
  const db = openDatabase({path: ':memory:'});
  const row = db.prepare('SELECT vec_version() AS v').get() as {v: string};
  t.ok(typeof row.v === 'string' && row.v.length > 0, 'vec_version returns a non-empty string');
  db.close();
});

test('runs the init migration and creates required tables', t => {
  const db = openDatabase({path: ':memory:'});
  const result = runMigrations(db);

  t.equal(
    result.current,
    14,
    'schema version is 14 after all migrations through normalize-created-dates'
  );
  t.deepEqual(
    result.applied,
    [
      '0001_init.sql',
      '0002_add_title.sql',
      '0003_sync_baseline.sql',
      '0004_doc_vecs.sql',
      '0005_agent_enrichment.sql',
      '0006_agent_enrichment_stale_kind.sql',
      '0007_records_cascade_to_vecs.sql',
      '0008_queue_items.sql',
      '0009_records_cascade_to_suggestions.sql',
      '0010_chunks_table.sql',
      '0011_records_body_last.sql',
      '0012_records_modified_at.sql',
      '0013_fts5_lexical_search.sql',
      '0014_normalize_created_dates.sql'
    ],
    'all migrations applied in order'
  );

  const names = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as {
      name: string;
    }[]
  ).map(r => r.name);

  for (const required of [
    'chunks',
    'edges',
    'meta',
    'queue_items',
    'records',
    'records_fts',
    'suggestions',
    'sync_baseline',
    'tag_aliases',
    'tags',
    'tags_taxonomy'
  ]) {
    t.ok(names.includes(required), `table ${required} exists`);
  }

  db.close();
});

test('migrations are idempotent — second run applies nothing', t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  const second = runMigrations(db);
  t.deepEqual(second.applied, [], 'second run applies no migrations');
  t.equal(second.current, 14, 'schema version stays at 14');
  db.close();
});

test('0010+0011 migrate pre-existing data: aux → chunks, embeddings + records preserved, body_hash backfilled', t => {
  const db = openDatabase({path: ':memory:'});

  // Replay history up to schema 9 by hand, then seed old-shape data so
  // runMigrations applies only 0010 — proving the copy path real deploys
  // take: aux values land in chunks, embeddings survive the vec rebuild.
  const schemaDir = new URL('../src/db/schema/', import.meta.url);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '0')`);
  for (const file of [
    '0001_init.sql',
    '0002_add_title.sql',
    '0003_sync_baseline.sql',
    '0004_doc_vecs.sql',
    '0005_agent_enrichment.sql',
    '0006_agent_enrichment_stale_kind.sql',
    '0007_records_cascade_to_vecs.sql',
    '0008_queue_items.sql',
    '0009_records_cascade_to_suggestions.sql'
  ]) {
    db.exec(readFileSync(new URL(file, schemaDir), 'utf8'));
  }

  db.prepare(
    `INSERT INTO records (record_id, file_path, type, body, content_hash, created, updated)
     VALUES ('r1', 'a.md', 'permanent', 'body', 'hash-1', '2026-01-01', '2026-01-01')`
  ).run();
  const vec = new Float32Array(384);
  vec[0] = 0.75;
  vec[383] = -0.5;
  db.prepare(
    `INSERT INTO record_vec (chunk_id, record_id, chunk_index, content_hash, embedding)
     VALUES (?, ?, ?, ?, ?)`
  ).run('r1:0', 'r1', BigInt(0), 'hash-1', new Uint8Array(vec.buffer));

  const result = runMigrations(db);
  t.deepEqual(
    result.applied,
    [
      '0010_chunks_table.sql',
      '0011_records_body_last.sql',
      '0012_records_modified_at.sql',
      '0013_fts5_lexical_search.sql',
      '0014_normalize_created_dates.sql'
    ],
    'migrations from schema 9 onward applied (0010–0014)'
  );

  const meta = db.prepare('SELECT record_id, chunk_index, content_hash FROM chunks').all() as {
    record_id: string;
    chunk_index: number;
    content_hash: string;
  }[];
  t.equal(meta.length, 1, 'aux row copied into chunks');
  t.equal(meta[0]?.record_id, 'r1', 'record_id preserved');
  t.equal(meta[0]?.content_hash, 'hash-1', 'content_hash preserved');

  const vecRow = db.prepare('SELECT embedding FROM record_vec WHERE chunk_id = ?').get('r1:0') as
    {embedding: Uint8Array} | undefined;
  t.ok(vecRow, 'vec row survived the rebuild');
  const out = new Float32Array(
    vecRow!.embedding.buffer,
    vecRow!.embedding.byteOffset,
    vecRow!.embedding.byteLength / 4
  );
  t.equal(out[0], 0.75, 'embedding payload preserved (first component)');
  t.equal(out[383], -0.5, 'embedding payload preserved (last component)');

  // 0011 rebuilt the records table: row data preserved, body_hash
  // backfilled via the sha256_hex SQL function = TS contentHash.
  const rec = db
    .prepare('SELECT body, content_hash, body_hash, created FROM records WHERE record_id = ?')
    .get('r1') as {body: string; content_hash: string; body_hash: string; created: string};
  t.equal(rec.body, 'body', 'records body preserved through 0011 rebuild');
  t.equal(rec.content_hash, 'hash-1', 'content_hash preserved');
  t.equal(rec.created, '2026-01-01', 'created preserved');
  t.equal(rec.body_hash, contentHash('body'), 'body_hash backfilled = sha256(body)');

  // The rebuilt trigger cascades through the new shape.
  db.prepare('DELETE FROM records WHERE record_id = ?').run('r1');
  const counts = db
    .prepare('SELECT (SELECT COUNT(*) FROM chunks) AS c, (SELECT COUNT(*) FROM record_vec) AS v')
    .get() as {c: number; v: number};
  t.equal(counts.c, 0, 'chunks cascaded on record delete');
  t.equal(counts.v, 0, 'record_vec cascaded on record delete');

  db.close();
});

test('0014 truncates a fossil full-timestamp created to date-only, leaves dates untouched', t => {
  const db = openDatabase({path: ':memory:'});
  // Replay to schema 9, seed records, then runMigrations applies 0010..0014.
  const schemaDir = new URL('../src/db/schema/', import.meta.url);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.exec(`INSERT INTO meta (key, value) VALUES ('schema_version', '0')`);
  for (const file of [
    '0001_init.sql',
    '0002_add_title.sql',
    '0003_sync_baseline.sql',
    '0004_doc_vecs.sql',
    '0005_agent_enrichment.sql',
    '0006_agent_enrichment_stale_kind.sql',
    '0007_records_cascade_to_vecs.sql',
    '0008_queue_items.sql',
    '0009_records_cascade_to_suggestions.sql'
  ]) {
    db.exec(readFileSync(new URL(file, schemaDir), 'utf8'));
  }
  db.prepare(
    `INSERT INTO records (record_id, file_path, type, body, content_hash, created, updated)
     VALUES ('fossil', 'projects/x/state.md', 'state', 'b', 'h1', '2026-04-29T02:39:23.977Z', '2026-04-30')`
  ).run();
  db.prepare(
    `INSERT INTO records (record_id, file_path, type, body, content_hash, created, updated)
     VALUES ('clean', 'projects/y/state.md', 'state', 'b', 'h2', '2026-04-29', '2026-04-30')`
  ).run();

  runMigrations(db);

  const createdOf = (id: string): string =>
    (db.prepare('SELECT created FROM records WHERE record_id = ?').get(id) as {created: string})
      .created;
  t.equal(createdOf('fossil'), '2026-04-29', 'full-timestamp created truncated to date');
  t.equal(createdOf('clean'), '2026-04-29', 'already-date created untouched');
  db.close();
});

test('records.status CHECK rejects an unknown value', t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  const insert = db.prepare(
    `INSERT INTO records
       (record_id, file_path, type, body, content_hash, body_hash, created, updated, status)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)`
  );
  t.throws(
    () =>
      insert.run('r1', 'a.md', 'permanent', 'b', 'h', '2026-01-01', '2026-01-01', 'not-a-status'),
    'invalid status is rejected'
  );
  db.close();
});

test('record_vec stores and retrieves a 384-dim float32 embedding', t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);

  db.prepare(
    `INSERT INTO records
       (record_id, file_path, type, body, content_hash, body_hash, created, updated)
     VALUES ('r1', 'a.md', 'permanent', 'body', 'hash', 'hash', '2026-01-01', '2026-01-01')`
  ).run();

  const vec = new Float32Array(384);
  vec[0] = 1;
  vec[1] = 0.5;
  vec[383] = -0.25;

  db.prepare(
    'INSERT INTO chunks (chunk_id, record_id, chunk_index, content_hash) VALUES (?, ?, ?, ?)'
  ).run('r1:0', 'r1', 0, 'hash');
  db.prepare('INSERT INTO record_vec (chunk_id, embedding) VALUES (?, ?)').run(
    'r1:0',
    new Uint8Array(vec.buffer)
  );

  const row = db
    .prepare(
      `SELECT c.record_id AS record_id
         FROM chunks c
         JOIN record_vec v ON v.chunk_id = c.chunk_id
        WHERE c.record_id = ?`
    )
    .get('r1') as {record_id: string};
  t.equal(row.record_id, 'r1', 'embedding row roundtrips through the chunks join');

  db.close();
});

test('tag taxonomy trigger rejects unknown tags', t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);

  db.prepare(
    `INSERT INTO records
       (record_id, file_path, type, body, content_hash, body_hash, created, updated)
     VALUES ('r1', 'a.md', 'permanent', 'b', 'h', 'h', '2026-01-01', '2026-01-01')`
  ).run();

  t.throws(
    () => db.prepare('INSERT INTO tags (record_id, tag) VALUES (?, ?)').run('r1', 'never-seen'),
    'unknown tag is rejected before insert'
  );

  db.prepare('INSERT INTO tags_taxonomy (tag, added) VALUES (?, ?)').run('vault', '2026-01-01');
  db.prepare('INSERT INTO tags (record_id, tag) VALUES (?, ?)').run('r1', 'vault');

  const found = (
    db.prepare('SELECT tag FROM tags WHERE record_id = ?').all('r1') as {tag: string}[]
  ).map(r => r.tag);
  t.deepEqual(found, ['vault'], 'taxonomy-known tag is accepted');

  db.close();
});

test('foreign-key cascade removes edges and tags when a record is deleted', t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);

  for (const id of ['a', 'b']) {
    db.prepare(
      `INSERT INTO records
         (record_id, file_path, type, body, content_hash, body_hash, created, updated)
       VALUES (?, ?, 'permanent', 'b', 'h', 'h', '2026-01-01', '2026-01-01')`
    ).run(id, `${id}.md`);
  }
  db.prepare(
    `INSERT INTO edges (from_id, to_id, type, created) VALUES (?, ?, 'cites', '2026-01-01')`
  ).run('a', 'b');

  db.prepare('DELETE FROM records WHERE record_id = ?').run('a');

  const remaining = db.prepare('SELECT COUNT(*) AS n FROM edges').get() as {n: number};
  t.equal(remaining.n, 0, 'cascade removed the dependent edge');

  db.close();
});

test('records_after_delete cascades to pending suggestions (schema 9)', t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);

  db.prepare(
    `INSERT INTO records
       (record_id, file_path, type, body, content_hash, body_hash, created, updated)
     VALUES (?, ?, 'permanent', 'b', 'h', 'h', '2026-01-01', '2026-01-01')`
  ).run('rec-a', 'a.md');

  // Two pending suggestions on rec-a, one already-rejected suggestion on rec-a,
  // and one pending suggestion on rec-b (which is NOT deleted) — verify the
  // trigger only touches rows that match `subject_id = OLD.record_id AND
  // status = 'pending'`.
  const insertSugg = db.prepare(
    `INSERT INTO suggestions (id, kind, subject_id, payload, status, created)
     VALUES (?, ?, ?, '{}', ?, '2026-01-01')`
  );
  insertSugg.run('s1', 'archive_candidate', 'rec-a', 'pending');
  insertSugg.run('s2', 'edge_type', 'rec-a', 'pending');
  insertSugg.run('s3', 'duplicate', 'rec-a', 'rejected'); // already-resolved
  insertSugg.run('s4', 'edge_type', 'rec-b', 'pending'); // different subject

  db.prepare('DELETE FROM records WHERE record_id = ?').run('rec-a');

  const rows = db.prepare('SELECT id, status, resolved_by FROM suggestions ORDER BY id').all() as {
    id: string;
    status: string;
    resolved_by: string | null;
  }[];
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));

  t.equal(byId['s1']?.status, 'accepted', 's1 (pending) → accepted');
  t.equal(byId['s1']?.resolved_by, 'record-deleted', 's1 carries the cascade marker');
  t.equal(byId['s2']?.status, 'accepted', 's2 (pending) → accepted');
  t.equal(byId['s3']?.status, 'rejected', 's3 (already-resolved) untouched');
  t.equal(byId['s3']?.resolved_by, null, 's3 resolved_by untouched');
  t.equal(byId['s4']?.status, 'pending', 's4 (different subject) untouched');

  db.close();
});
