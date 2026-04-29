import test from 'tape-six';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {RecordVecRepository} from '../src/db/vec-repo.ts';
import {embedPending} from '../src/embeddings/embed-pass.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {RecordsRepository} from '../src/records/repository.ts';
import type {VaultRecord} from '../src/records/types.ts';
import {contentHash} from '../src/util/hash.ts';
import {uuidv7} from '../src/util/uuid.ts';

const makeRecord = (path: string, body: string): VaultRecord => ({
  recordId: uuidv7(),
  filePath: path,
  parentPath: null,
  sequenceKey: null,
  type: 'permanent',
  body,
  contentHash: contentHash(body),
  title: null,
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

test('embedPending', async t => {
  await t.test('embeds every record on the first pass', async t => {
    const fx = setup();
    try {
      const a = makeRecord('topics/a.md', 'alpha body');
      const b = makeRecord('topics/b.md', 'beta body');
      const c = makeRecord('topics/c.md', 'gamma body');
      fx.records.insert(a);
      fx.records.insert(b);
      fx.records.insert(c);

      const summary = await embedPending(fx.db, fx.embedder);
      t.equal(summary.embedded, 3, 'all three embedded');
      t.equal(summary.upToDate, 0, 'none up-to-date yet');
      t.equal(summary.total, 3, 'total counts all records');
      t.equal(fx.vecs.countRecords(), 3, 'three vectors stored');
      t.equal(fx.vecs.getRecordContentHash(a.recordId), a.contentHash, 'hash matches body');
    } finally {
      fx.db.close();
    }
  });

  await t.test('second pass with no body changes embeds nothing', async t => {
    const fx = setup();
    try {
      const a = makeRecord('topics/a.md', 'alpha body');
      fx.records.insert(a);

      const first = await embedPending(fx.db, fx.embedder);
      t.equal(first.embedded, 1, 'first pass embeds the new record');

      const second = await embedPending(fx.db, fx.embedder);
      t.equal(second.embedded, 0, 'second pass embeds nothing');
      t.equal(second.upToDate, 1, 'one record up-to-date');
    } finally {
      fx.db.close();
    }
  });

  await t.test('re-embeds a record whose content_hash has changed', async t => {
    const fx = setup();
    try {
      const a = makeRecord('topics/a.md', 'first body');
      fx.records.insert(a);
      await embedPending(fx.db, fx.embedder);
      const firstVec = await fx.embedder.embed(a.body);

      // Body changes — same path, new content_hash.
      const updated = {...a, body: 'second body', contentHash: contentHash('second body')};
      fx.records.upsertByPath(updated);

      const summary = await embedPending(fx.db, fx.embedder);
      t.equal(summary.embedded, 1, 'one re-embedded');
      t.equal(fx.vecs.getRecordContentHash(a.recordId), updated.contentHash, 'new hash recorded');

      const newVec = await fx.embedder.embed(updated.body);
      t.notDeepEqual(
        Array.from(firstVec),
        Array.from(newVec),
        'fake embedder produces different vectors for different inputs (sanity)'
      );
    } finally {
      fx.db.close();
    }
  });

  await t.test('only embeds the missing one when others are up-to-date', async t => {
    const fx = setup();
    try {
      const a = makeRecord('topics/a.md', 'alpha');
      const b = makeRecord('topics/b.md', 'beta');
      fx.records.insert(a);
      fx.records.insert(b);

      // Pre-embed only `a`.
      const aVec = await fx.embedder.embed(a.body);
      fx.vecs.setChunks(a.recordId, a.contentHash, [aVec]);

      const summary = await embedPending(fx.db, fx.embedder);
      t.equal(summary.embedded, 1, 'only b was pending');
      t.equal(summary.upToDate, 1, 'a was already up-to-date');
      t.equal(fx.vecs.countRecords(), 2, 'now two vectors total');
    } finally {
      fx.db.close();
    }
  });

  await t.test('respects the batchSize option', async t => {
    const fx = setup();
    try {
      for (let i = 0; i < 10; i++) {
        fx.records.insert(makeRecord(`topics/${i}.md`, `body-${i}`));
      }
      const summary = await embedPending(fx.db, fx.embedder, {batchSize: 3});
      t.equal(summary.embedded, 10, 'all ten embedded across small batches');
      t.equal(fx.vecs.countRecords(), 10, 'all ten vectors stored');
    } finally {
      fx.db.close();
    }
  });
});
