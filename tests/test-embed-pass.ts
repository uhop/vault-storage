import test from 'tape-six';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {RecordVecRepository} from '../src/db/vec-repo.ts';
import {embedPending} from '../src/embeddings/embed-pass.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import type {Embedder} from '../src/embeddings/types.ts';
import {RecordsRepository} from '../src/records/repository.ts';
import type {VaultRecord} from '../src/records/types.ts';
import {contentHash, embedInputHash} from '../src/util/hash.ts';
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
  archivedAt: null,
  agentSummary: null,
  agentDerivedFromHash: null
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

  await t.test('agent.summary is embedded into chunk text', async t => {
    const fx = setup();
    try {
      const summary = 'TLDR — three sentences distilling the doc.';
      const body = 'distinct body content that does not contain the summary text';
      const r = makeRecord('topics/a.md', body);
      r.agentSummary = summary;
      r.agentDerivedFromHash = contentHash(body);
      r.contentHash = embedInputHash(body, summary);
      fx.records.insert(r);

      await embedPending(fx.db, fx.embedder);

      // The fake embedder is deterministic per-input. Embedding the
      // summary-prepended chunk text should match the on-disk vector;
      // embedding body alone should NOT.
      const expectedVec = await fx.embedder.embed(`${summary}\n\n${body}`);
      const bodyOnlyVec = await fx.embedder.embed(body);

      const stored = fx.db
        .prepare('SELECT embedding FROM record_vec WHERE record_id = ?')
        .get(r.recordId) as {embedding: Uint8Array};
      const storedFloats = new Float32Array(
        stored.embedding.buffer,
        stored.embedding.byteOffset,
        stored.embedding.byteLength / 4
      );
      t.deepEqual(
        Array.from(storedFloats),
        Array.from(expectedVec),
        'stored chunk vector matches summary+body'
      );
      t.notDeepEqual(
        Array.from(storedFloats),
        Array.from(bodyOnlyVec),
        'stored chunk vector differs from body-only embedding'
      );
    } finally {
      fx.db.close();
    }
  });

  await t.test('summary-only change re-embeds (content_hash drift)', async t => {
    const fx = setup();
    try {
      const body = 'unchanged body content';
      const r = makeRecord('topics/a.md', body);
      r.agentSummary = 'first summary';
      r.contentHash = embedInputHash(body, r.agentSummary);
      fx.records.insert(r);
      const first = await embedPending(fx.db, fx.embedder);
      t.equal(first.embedded, 1, 'first pass embeds');

      // New summary, same body — embedInputHash changes, embedPending must
      // pick the record back up.
      const updated = {
        ...r,
        agentSummary: 'second, different summary',
        contentHash: embedInputHash(body, 'second, different summary')
      };
      fx.records.upsertByPath(updated);

      const second = await embedPending(fx.db, fx.embedder);
      t.equal(second.embedded, 1, 'summary-only edit triggers re-embed');
      t.equal(fx.vecs.getRecordContentHash(r.recordId), updated.contentHash, 'new hash recorded');
    } finally {
      fx.db.close();
    }
  });

  await t.test('drops non-finite chunk vectors before persisting', async t => {
    // BGE/transformers.js occasionally produces a NaN chunk on otherwise
    // normal inputs. Without this filter, a single bad chunk poisons the
    // mean-pool sum and yields an all-NaN doc-vec — which sqlite-vec then
    // returns as null distance on every neighbour query (the 2026-05-03
    // 144-suggestion regression). Verifies a partial-NaN record gets a
    // clean doc-vec computed from the surviving chunks.
    // record_vec is a vec0 virtual table with fixed dim=384; mirror that here.
    const DIM = 384;
    class NaNOnInputEmbedder implements Embedder {
      readonly dim = DIM;
      readonly modelName = 'nan-on-input';
      readonly badPattern: string;
      constructor(badPattern: string) {
        this.badPattern = badPattern;
      }
      async embed(text: string): Promise<Float32Array> {
        const v = new Float32Array(DIM);
        if (text.includes(this.badPattern)) {
          v.fill(NaN);
        } else {
          v[0] = 1;
        }
        return v;
      }
      async embedBatch(texts: string[]): Promise<Float32Array[]> {
        return Promise.all(texts.map(t => this.embed(t)));
      }
    }

    const fx = setup();
    try {
      // Two records: one whose body the embedder NaNs, one it doesn't.
      const good = makeRecord('topics/good.md', 'plain body that embeds cleanly');
      const bad = makeRecord('topics/bad.md', 'this body contains the SENTINEL marker');
      fx.records.insert(good);
      fx.records.insert(bad);

      const embedder = new NaNOnInputEmbedder('SENTINEL');
      const summary = await embedPending(fx.db, embedder);

      // good record gets one clean chunk + doc-vec; bad record's only chunk
      // is NaN, so it falls into the all-NaN persist-anyway branch — chunks
      // written, doc-vec NOT written.
      t.equal(summary.embedded, 2, 'both records counted as embedded');
      t.equal(summary.docVecsWritten, 1, 'only the clean record got a doc-vec');

      const goodChunkRow = fx.db
        .prepare('SELECT embedding FROM record_vec WHERE record_id = ?')
        .get(good.recordId) as {embedding: Uint8Array};
      const goodFloats = new Float32Array(
        goodChunkRow.embedding.buffer,
        goodChunkRow.embedding.byteOffset,
        goodChunkRow.embedding.byteLength / 4
      );
      t.ok(
        Array.from(goodFloats).every(v => Number.isFinite(v)),
        'clean record stored finite chunk vector'
      );

      const goodDocCount = (
        fx.db
          .prepare('SELECT COUNT(*) AS n FROM record_doc_vec WHERE record_id = ?')
          .get(good.recordId) as {n: number}
      ).n;
      t.equal(goodDocCount, 1, 'clean record has a doc-vec row');

      const badDocCount = (
        fx.db
          .prepare('SELECT COUNT(*) AS n FROM record_doc_vec WHERE record_id = ?')
          .get(bad.recordId) as {n: number}
      ).n;
      t.equal(badDocCount, 0, 'all-NaN record has no doc-vec row');
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
