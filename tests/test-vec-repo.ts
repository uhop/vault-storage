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

test('RecordVecRepository setChunks / has / count / hash', async t => {
  const fx = setup();
  try {
    const id = uuidv7();
    fx.records.insert(makeRecord(id, 'topics/a.md'));
    const v1 = await fx.embedder.embed('a body part 1');
    const v2 = await fx.embedder.embed('a body part 2');

    await t.test('setChunks inserts one row per chunk', t => {
      fx.vecs.setChunks(id, 'hash-v1', [v1, v2]);
      t.ok(fx.vecs.hasRecord(id), 'hasRecord true after setChunks');
      t.equal(fx.vecs.countChunks(), 2, 'two chunk rows');
      t.equal(fx.vecs.countRecords(), 1, 'one record');
      t.equal(fx.vecs.getRecordContentHash(id), 'hash-v1', 'content_hash recorded');
    });

    await t.test('setChunks replaces the previous chunk set atomically', t => {
      const v3 = new Float32Array(384);
      v3[0] = 1;
      fx.vecs.setChunks(id, 'hash-v2', [v3]);
      t.equal(fx.vecs.countChunks(), 1, 'one chunk after replace');
      t.equal(fx.vecs.countRecords(), 1, 'still one record');
      t.equal(fx.vecs.getRecordContentHash(id), 'hash-v2', 'hash refreshed');
    });

    await t.test('deleteRecord removes all chunks for the record', t => {
      t.ok(fx.vecs.deleteRecord(id), 'deleteRecord returns true');
      t.notOk(fx.vecs.hasRecord(id), 'hasRecord false after delete');
      t.equal(fx.vecs.countChunks(), 0, 'no chunks left');
      t.equal(fx.vecs.getRecordContentHash(id), null, 'hash returns null');
    });
  } finally {
    fx.db.close();
  }
});

test('nearest returns closest record (best chunk) ordered by distance', async t => {
  const fx = setup();
  try {
    const ids: string[] = [];
    const bodies = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    for (const body of bodies) {
      const id = uuidv7();
      fx.records.insert(makeRecord(id, `topics/${body}.md`, body));
      const v = await fx.embedder.embed(body);
      fx.vecs.setChunks(id, `hash-${body}`, [v]);
      ids.push(id);
    }

    await t.test('exact match is at distance ~0', async t => {
      const queryVec = await fx.embedder.embed('beta');
      const hits = fx.vecs.nearest(queryVec, 5);
      t.equal(hits.length, 5, 'returns k records');
      t.equal(hits[0]?.recordId, ids[1], 'beta is the nearest hit');
      t.ok((hits[0]?.distance ?? 1) < 1e-3, 'self-distance is near zero');
    });

    await t.test('multi-chunk record uses best chunk as the record score', async t => {
      // Add a 6th record whose first chunk is irrelevant but second chunk
      // matches "beta" closely. The record-level score should reflect the
      // good chunk, not the bad one.
      const id6 = uuidv7();
      fx.records.insert(makeRecord(id6, 'topics/multi.md', 'multi'));
      const irrelevant = await fx.embedder.embed('zeta');
      const close = await fx.embedder.embed('beta');
      fx.vecs.setChunks(id6, 'hash-multi', [irrelevant, close]);

      const queryVec = await fx.embedder.embed('beta');
      const hits = fx.vecs.nearest(queryVec, 6);
      const rec = hits.find(h => h.recordId === id6);
      t.ok(rec, 'multi-chunk record is in nearest results');
      t.ok((rec?.distance ?? 1) < 1e-3, 'distance reflects best chunk, not worst');
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
