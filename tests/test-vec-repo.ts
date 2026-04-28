import test from 'tape-six';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {RecordVecRepository} from '../src/db/vec-repo.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {RecordsRepository} from '../src/records/repository.ts';
import type {VaultRecord} from '../src/records/types.ts';
import {uuidv7} from '../src/util/uuid.ts';

const makeRecord = (id: string, path: string, body = 'b'): VaultRecord => ({
  recordId: id,
  filePath: path,
  parentPath: null,
  sequenceKey: null,
  type: 'permanent',
  body,
  contentHash: 'h',
  created: '2026-04-28',
  updated: '2026-04-28',
  lastReferenced: null,
  decayScore: 1,
  status: 'active',
  priority: 0,
  archivedAt: null
});

interface Fixture {
  db: DatabaseSync;
  records: RecordsRepository;
  vecs: RecordVecRepository;
  embedder: FakeEmbedder;
}

const setup = (): Fixture => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  return {
    db,
    records: new RecordsRepository(db),
    vecs: new RecordVecRepository(db),
    embedder: new FakeEmbedder()
  };
};

test('RecordVecRepository CRUD', async t => {
  const fx = setup();
  try {
    const id = uuidv7();
    fx.records.insert(makeRecord(id, 'topics/a.md'));
    const vec = await fx.embedder.embed('a body');

    await t.test('insert + has + count + getContentHash', t => {
      fx.vecs.insert(id, 'hash-v1', vec);
      t.ok(fx.vecs.has(id), 'has returns true after insert');
      t.equal(fx.vecs.count(), 1, 'count is 1');
      t.equal(fx.vecs.getContentHash(id), 'hash-v1', 'content_hash stored');
    });

    await t.test('upsert replaces the vector and content_hash', t => {
      const vec2 = new Float32Array(384);
      vec2[0] = 1;
      fx.vecs.upsert(id, 'hash-v2', vec2);
      t.equal(fx.vecs.count(), 1, 'still one row');
      t.equal(fx.vecs.getContentHash(id), 'hash-v2', 'content_hash refreshed');
    });

    await t.test('delete removes the row', t => {
      t.ok(fx.vecs.delete(id), 'delete returns true');
      t.notOk(fx.vecs.has(id), 'has returns false after delete');
      t.equal(fx.vecs.count(), 0, 'count back to 0');
      t.equal(fx.vecs.getContentHash(id), null, 'getContentHash returns null after delete');
    });
  } finally {
    fx.db.close();
  }
});

test('nearest returns the closest record_id and orders by distance', async t => {
  const fx = setup();
  try {
    // Insert 5 records with distinct embeddings keyed by their body text.
    const ids: string[] = [];
    const bodies = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    for (const body of bodies) {
      const id = uuidv7();
      fx.records.insert(makeRecord(id, `topics/${body}.md`, body));
      const v = await fx.embedder.embed(body);
      fx.vecs.insert(id, `hash-${body}`, v);
      ids.push(id);
    }

    await t.test('exact match is at distance ~0', async t => {
      const queryVec = await fx.embedder.embed('beta');
      const hits = fx.vecs.nearest(queryVec, 5);
      t.equal(hits.length, 5, 'returns k results when k ≤ count');
      t.equal(hits[0]?.recordId, ids[1], 'beta is the nearest hit');
      t.ok((hits[0]?.distance ?? 1) < 1e-3, 'self-distance is near zero');
    });

    await t.test('k limits the result set', async t => {
      const queryVec = await fx.embedder.embed('gamma');
      const hits = fx.vecs.nearest(queryVec, 2);
      t.equal(hits.length, 2, 'k=2 returns 2');
      t.equal(hits[0]?.recordId, ids[2], 'gamma first');
    });

    await t.test('ordered by ascending distance', async t => {
      const queryVec = await fx.embedder.embed('delta');
      const hits = fx.vecs.nearest(queryVec, 5);
      for (let i = 1; i < hits.length; i++) {
        t.ok(
          (hits[i]?.distance ?? 0) >= (hits[i - 1]?.distance ?? 0),
          `position ${i} ≥ position ${i - 1}`
        );
      }
    });
  } finally {
    fx.db.close();
  }
});
