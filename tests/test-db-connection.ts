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
    37,
    'schema version is 37 after all migrations through the index of external links'
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
      '0014_normalize_created_dates.sql',
      '0015_suggestion_claims.sql',
      '0016_queue_blocked_by.sql',
      '0017_leases.sql',
      '0018_handoffs.sql',
      '0019_handoff_artifact_event.sql',
      '0020_suggestion_evidence.sql',
      '0021_handoff_touches_verification.sql',
      '0022_suggestion_identity_indexes.sql',
      '0023_chunk_text_hash.sql',
      '0024_record_summary_vec.sql',
      '0025_body_field_observations.sql',
      '0026_claim_tokens.sql',
      '0027_enrichment_baselines.sql',
      '0028_edge_type_default_cites.sql',
      '0029_tag_origin.sql',
      '0030_tag_vecs.sql',
      '0031_edge_vocabulary.sql',
      '0032_fm_findings.sql',
      '0033_records_project.sql',
      '0034_queue_source.sql',
      '0035_queue_inbox.sql',
      '0036_fleet_state.sql',
      '0037_external_links.sql'
    ],
    'all migrations applied in order'
  );
  t.deepEqual(
    result.reindex,
    result.applied.filter(
      name =>
        name !== '0023_chunk_text_hash.sql' &&
        name !== '0024_record_summary_vec.sql' &&
        name !== '0025_body_field_observations.sql' &&
        name !== '0026_claim_tokens.sql' &&
        name !== '0027_enrichment_baselines.sql' &&
        name !== '0028_edge_type_default_cites.sql' &&
        name !== '0029_tag_origin.sql' &&
        name !== '0030_tag_vecs.sql' &&
        name !== '0031_edge_vocabulary.sql' &&
        name !== '0035_queue_inbox.sql'
    ),
    'every migration forces a full import except the ones marked no-reindex'
  );

  const names = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as {
      name: string;
    }[]
  ).map(r => r.name);

  for (const required of [
    'chunks',
    'edges',
    'enrichment_baselines',
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

test('0035 rebuilds queue_items with the inbox section and keeps every row', t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  // Rewind to 34: the 0008 table shape plus the 0016 and 0034 columns.
  db.exec(`
    DROP TABLE queue_items;
    CREATE TABLE queue_items (
      id TEXT PRIMARY KEY, project TEXT NOT NULL,
      section TEXT NOT NULL CHECK (section IN ('active', 'backlog', 'watching', 'archive')),
      priority INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL, title TEXT NOT NULL,
      title_norm TEXT NOT NULL, body TEXT NOT NULL, closed_at TEXT, close_reason TEXT,
      source_file TEXT NOT NULL, source_line INTEGER NOT NULL, body_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      blocked_by TEXT NOT NULL DEFAULT '[]', source TEXT,
      UNIQUE (project, section, title_norm));
    INSERT INTO queue_items (id, project, section, priority, position, title, title_norm, body,
      source_file, source_line, body_hash, created_at, updated_at, blocked_by, source)
      VALUES ('q1', 'p', 'backlog', 1, 1, 'One.', 'one.', 'b', 'projects/p/queue.md', 3, 'h',
              '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', '["Two."]', 'github a/b#1');
    DROP TABLE fleet_runs;
    DROP TABLE fleet_baselines;
    DROP TABLE external_links;
    DROP TABLE project_github;
    UPDATE meta SET value = '34' WHERE key = 'schema_version';
  `);
  t.throws(
    () =>
      db.exec(
        `INSERT INTO queue_items (id, project, section, priority, position, title, title_norm, body, source_file, source_line, body_hash, created_at, updated_at) VALUES ('q2', 'p', 'inbox', 0, 1, 'T', 't', '', 'f', 1, 'h', 'x', 'x')`
      ),
    'inbox is refused before 0035'
  );
  const result = runMigrations(db);
  t.deepEqual(result.applied, [
    '0035_queue_inbox.sql',
    '0036_fleet_state.sql',
    '0037_external_links.sql'
  ]);
  t.deepEqual(
    result.reindex,
    ['0036_fleet_state.sql', '0037_external_links.sql'],
    'the rebuilt rows are the same rows: 0035 asks no reindex'
  );
  t.deepEqual(
    db
      .prepare('SELECT id, section, created_at, updated_at, blocked_by, source FROM queue_items')
      .all(),
    [
      {
        id: 'q1',
        section: 'backlog',
        created_at: '2026-09-01T00:00:00Z',
        updated_at: '2026-09-02T00:00:00Z',
        blocked_by: '["Two."]',
        source: 'github a/b#1'
      }
    ],
    'the row survives with its id, timestamps, refs, and source'
  );
  db.exec(
    `INSERT INTO queue_items (id, project, section, priority, position, title, title_norm, body, source_file, source_line, body_hash, created_at, updated_at) VALUES ('q2', 'p', 'inbox', 0, 1, 'T', 't', '', 'f', 1, 'h', 'x', 'x')`
  );
  t.equal(
    (
      db.prepare(`SELECT COUNT(*) AS n FROM queue_items WHERE section = 'inbox'`).get() as {
        n: number;
      }
    ).n,
    1,
    'inbox is accepted after'
  );
  t.deepEqual(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'queue_items' AND name LIKE 'idx_%' ORDER BY name`
        )
        .all() as {name: string}[]
    ).map(r => r.name),
    [
      'idx_queue_items_archive_by_date',
      'idx_queue_items_by_priority',
      'idx_queue_items_by_project',
      'idx_queue_items_open_by_prio',
      'idx_queue_items_source'
    ],
    'the five indexes are back'
  );
  db.close();
});

test('0026 releases the suggestion claims made before claim tokens', t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  db.exec(`
    DROP TRIGGER records_after_delete_resolve_suggestions;
    ALTER TABLE leases DROP COLUMN claim_token;
    ALTER TABLE handoffs DROP COLUMN claim_token;
    ALTER TABLE suggestions DROP COLUMN claim_token;
    DROP TABLE enrichment_baselines;
    ALTER TABLE tags_taxonomy DROP COLUMN origin;
    DROP INDEX idx_records_project;
    ALTER TABLE records DROP COLUMN project;
    DROP INDEX idx_queue_items_source;
    ALTER TABLE queue_items DROP COLUMN source;
    DROP TABLE fleet_runs;
    DROP TABLE fleet_baselines;
    DROP TABLE external_links;
    DROP TABLE project_github;
    UPDATE meta SET value = '25' WHERE key = 'schema_version';
    INSERT INTO suggestions (id, kind, payload, status, created, claimed_by, claimed_at, claim_expires)
      VALUES ('s1', 'duplicate', '{}', 'claimed', '2026-09-26T00:00:00Z', 'sweep-A',
              '2026-09-26T00:00:00Z', '2999-01-01T00:00:00Z');
  `);
  const result = runMigrations(db);
  t.deepEqual(result.applied, [
    '0026_claim_tokens.sql',
    '0027_enrichment_baselines.sql',
    '0028_edge_type_default_cites.sql',
    '0029_tag_origin.sql',
    '0030_tag_vecs.sql',
    '0031_edge_vocabulary.sql',
    '0032_fm_findings.sql',
    '0033_records_project.sql',
    '0034_queue_source.sql',
    '0035_queue_inbox.sql',
    '0036_fleet_state.sql',
    '0037_external_links.sql'
  ]);
  t.deepEqual(
    {...(db.prepare('SELECT status, claimed_by, claim_token FROM suggestions').get() as object)},
    {status: 'pending', claimed_by: null, claim_token: null},
    'a live claim with no token to present reverts to pending'
  );
  db.close();
});

test('0028 settles pending edge_type rows as default-cites, leaving claimed ones', t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  db.exec(`
    ALTER TABLE tags_taxonomy DROP COLUMN origin;
    DROP INDEX idx_records_project;
    ALTER TABLE records DROP COLUMN project;
    DROP INDEX idx_queue_items_source;
    ALTER TABLE queue_items DROP COLUMN source;
    DROP TABLE fleet_runs;
    DROP TABLE fleet_baselines;
    DROP TABLE external_links;
    DROP TABLE project_github;
    UPDATE meta SET value = '27' WHERE key = 'schema_version';
    INSERT INTO suggestions (id, kind, payload, status, created) VALUES
      ('p', 'edge_type', '{}', 'pending', '2026-09-27T00:00:00Z'),
      ('d', 'duplicate', '{}', 'pending', '2026-09-27T00:00:00Z');
    INSERT INTO suggestions (id, kind, payload, status, created, claimed_by, claimed_at, claim_expires)
      VALUES ('c', 'edge_type', '{}', 'claimed', '2026-09-27T00:00:00Z', 'sweep-A',
              '2026-09-27T00:00:00Z', '2999-01-01T00:00:00Z');
  `);
  const result = runMigrations(db);
  t.deepEqual(result.applied, [
    '0028_edge_type_default_cites.sql',
    '0029_tag_origin.sql',
    '0030_tag_vecs.sql',
    '0031_edge_vocabulary.sql',
    '0032_fm_findings.sql',
    '0033_records_project.sql',
    '0034_queue_source.sql',
    '0035_queue_inbox.sql',
    '0036_fleet_state.sql',
    '0037_external_links.sql'
  ]);
  t.deepEqual(
    result.reindex,
    [
      '0032_fm_findings.sql',
      '0033_records_project.sql',
      '0034_queue_source.sql',
      '0036_fleet_state.sql',
      '0037_external_links.sql'
    ],
    'the findings table, the project and source columns, the fleet tables, and the link index force a reindex'
  );
  const rows = db
    .prepare('SELECT id, status, resolved_by FROM suggestions ORDER BY id')
    .all()
    .map(row => ({...(row as object)}));
  t.deepEqual(rows, [
    {id: 'c', status: 'claimed', resolved_by: null},
    {id: 'd', status: 'pending', resolved_by: null},
    {id: 'p', status: 'rejected', resolved_by: 'default-cites'}
  ]);
  db.close();
});

test('0029 backfills tag origin: seeded on the migration date, minted otherwise', t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  db.exec(`
    ALTER TABLE tags_taxonomy DROP COLUMN origin;
    DROP INDEX idx_records_project;
    ALTER TABLE records DROP COLUMN project;
    DROP INDEX idx_queue_items_source;
    ALTER TABLE queue_items DROP COLUMN source;
    DROP TABLE fleet_runs;
    DROP TABLE fleet_baselines;
    DROP TABLE external_links;
    DROP TABLE project_github;
    UPDATE meta SET value = '28' WHERE key = 'schema_version';
    INSERT INTO tags_taxonomy (tag, added) VALUES
      ('seed', '2026-04-29'), ('later', '2026-06-14T10:00:00.000Z');
  `);
  t.deepEqual(runMigrations(db).applied, [
    '0029_tag_origin.sql',
    '0030_tag_vecs.sql',
    '0031_edge_vocabulary.sql',
    '0032_fm_findings.sql',
    '0033_records_project.sql',
    '0034_queue_source.sql',
    '0035_queue_inbox.sql',
    '0036_fleet_state.sql',
    '0037_external_links.sql'
  ]);
  const rows = db
    .prepare('SELECT tag, origin FROM tags_taxonomy ORDER BY tag')
    .all()
    .map(row => ({...(row as object)}));
  t.deepEqual(rows, [
    {tag: 'later', origin: 'minted'},
    {tag: 'seed', origin: 'seeded'}
  ]);
  t.throws(
    () =>
      db.exec(`INSERT INTO tags_taxonomy (tag, added, origin) VALUES ('x', '2026-09-28', 'bogus')`),
    'origin is a closed set'
  );
  db.close();
});

test('migrations are idempotent — second run applies nothing', t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  const second = runMigrations(db);
  t.deepEqual(second.applied, [], 'second run applies no migrations');
  t.equal(second.current, 37, 'schema version stays at 37');
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
      '0014_normalize_created_dates.sql',
      '0015_suggestion_claims.sql',
      '0016_queue_blocked_by.sql',
      '0017_leases.sql',
      '0018_handoffs.sql',
      '0019_handoff_artifact_event.sql',
      '0020_suggestion_evidence.sql',
      '0021_handoff_touches_verification.sql',
      '0022_suggestion_identity_indexes.sql',
      '0023_chunk_text_hash.sql',
      '0024_record_summary_vec.sql',
      '0025_body_field_observations.sql',
      '0026_claim_tokens.sql',
      '0027_enrichment_baselines.sql',
      '0028_edge_type_default_cites.sql',
      '0029_tag_origin.sql',
      '0030_tag_vecs.sql',
      '0031_edge_vocabulary.sql',
      '0032_fm_findings.sql',
      '0033_records_project.sql',
      '0034_queue_source.sql',
      '0035_queue_inbox.sql',
      '0036_fleet_state.sql',
      '0037_external_links.sql'
    ],
    'migrations from schema 9 onward applied (0010–0029)'
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

test('0020 backfills payload.evidence by kind on rows filed before the filer stamped it', t => {
  const db = openDatabase({path: ':memory:'});
  try {
    runMigrations(db);
    const insert = db.prepare(
      `INSERT INTO suggestions (id, kind, subject_id, payload, status, created) VALUES (?, ?, NULL, ?, 'pending', '2026-09-01T00:00:00Z')`
    );
    insert.run('e1', 'edge_type', JSON.stringify({from_record: 'a', to_record: 'b'}));
    insert.run('d1', 'duplicate', JSON.stringify({a_record: 'a', b_record: 'b', distance: 0.1}));
    insert.run('t1', 'tag_suggestion', JSON.stringify({tag: 'x', record_id: 'a'}));
    insert.run('c1', 'compaction_candidate', JSON.stringify({folder_path: 'logs/'}));
    insert.run(
      'k1',
      'edge_type',
      JSON.stringify({
        from_record: 'a',
        to_record: 'c',
        evidence: {source: 'agent', asserted: false}
      })
    );
    // The backfill is plain UPDATEs, so the file re-applies on a migrated DB.
    db.exec(
      readFileSync(
        new URL('../src/db/schema/0020_suggestion_evidence.sql', import.meta.url),
        'utf8'
      )
    );
    const evidence = (id: string) =>
      JSON.parse(
        (db.prepare('SELECT payload FROM suggestions WHERE id = ?').get(id) as {payload: string})
          .payload
      ).evidence;
    t.deepEqual(
      evidence('e1'),
      {source: 'structural', asserted: true},
      'edge_type → structural, asserted'
    );
    t.deepEqual(
      evidence('d1'),
      {source: 'vector', asserted: false},
      'duplicate → vector, surfaced'
    );
    t.deepEqual(evidence('t1'), {source: 'agent', asserted: false}, 'tag_suggestion → agent');
    t.deepEqual(
      evidence('c1'),
      {source: 'metric', asserted: true},
      'compaction → metric, asserted'
    );
    t.deepEqual(
      evidence('k1'),
      {source: 'agent', asserted: false},
      'an existing evidence key is left alone'
    );
  } finally {
    db.close();
  }
});
