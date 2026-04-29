import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';

test('opens an in-memory DB with sqlite-vec loaded', t => {
  const db = openDatabase({path: ':memory:'});
  const row = db.prepare('SELECT vec_version() AS v').get() as {v: string};
  t.ok(typeof row.v === 'string' && row.v.length > 0, 'vec_version returns a non-empty string');
  db.close();
});

test('runs the init migration and creates required tables', t => {
  const db = openDatabase({path: ':memory:'});
  const result = runMigrations(db);

  t.equal(result.current, 1, 'schema version is 1 after init');
  t.deepEqual(result.applied, ['0001_init.sql'], 'init migration was applied');

  const names = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as {
      name: string;
    }[]
  ).map(r => r.name);

  for (const required of [
    'edges',
    'meta',
    'records',
    'suggestions',
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
  t.equal(second.current, 1, 'schema version stays at 1');
  db.close();
});

test('records.status CHECK rejects an unknown value', t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  const insert = db.prepare(
    `INSERT INTO records
       (record_id, file_path, type, body, content_hash, created, updated, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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
       (record_id, file_path, type, body, content_hash, created, updated)
     VALUES ('r1', 'a.md', 'permanent', 'body', 'hash', '2026-01-01', '2026-01-01')`
  ).run();

  const vec = new Float32Array(384);
  vec[0] = 1;
  vec[1] = 0.5;
  vec[383] = -0.25;

  db.prepare(
    'INSERT INTO record_vec (chunk_id, record_id, chunk_index, embedding) VALUES (?, ?, ?, ?)'
  ).run('r1:0', 'r1', BigInt(0), new Uint8Array(vec.buffer));

  const row = db.prepare(`SELECT record_id FROM record_vec WHERE record_id = ?`).get('r1') as {
    record_id: string;
  };
  t.equal(row.record_id, 'r1', 'embedding row roundtrips');

  db.close();
});

test('tag taxonomy trigger rejects unknown tags', t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);

  db.prepare(
    `INSERT INTO records
       (record_id, file_path, type, body, content_hash, created, updated)
     VALUES ('r1', 'a.md', 'permanent', 'b', 'h', '2026-01-01', '2026-01-01')`
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
         (record_id, file_path, type, body, content_hash, created, updated)
       VALUES (?, ?, 'permanent', 'b', 'h', '2026-01-01', '2026-01-01')`
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
