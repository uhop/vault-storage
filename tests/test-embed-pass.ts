import test from 'tape-six';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {RecordSummaryVecRepository} from '../src/db/summary-vec-repo.ts';
import {RecordVecRepository} from '../src/db/vec-repo.ts';
import {chunkBody} from '../src/embeddings/chunker.ts';
import {embedAllPending, embedPending} from '../src/embeddings/embed-pass.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import type {Embedder} from '../src/embeddings/types.ts';
import {backfillChunkTextHashes} from '../src/maintenance/backfill-chunk-text-hashes.ts';
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
  bodyHash: contentHash(body),
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

  await t.test('agent.summary gets its own vector and stays out of chunk text', async t => {
    const fx = setup();
    try {
      const summary = 'TLDR — three sentences distilling the doc.';
      const body = 'distinct body content that does not contain the summary text';
      const r = makeRecord('topics/a.md', body);
      r.agentSummary = summary;
      r.agentDerivedFromHash = contentHash(body);
      r.contentHash = embedInputHash(body, summary);
      fx.records.insert(r);

      const pass = await embedPending(fx.db, fx.embedder);
      t.equal(pass.summaryVecsWritten, 1, 'one summary vector written');

      const [chunk] = fx.vecs.getChunks(r.recordId);
      t.deepEqual(
        Array.from(chunk!),
        Array.from(await fx.embedder.embed(body)),
        'the chunk vector embeds the body alone'
      );
      const stored = new RecordSummaryVecRepository(fx.db).get(r.recordId);
      t.deepEqual(
        Array.from(stored!.embedding),
        Array.from(await fx.embedder.embed(summary)),
        'the summary vector embeds the summary alone'
      );
      t.equal(stored!.contentHash, r.contentHash, 'it carries the record content_hash');
      t.equal(stored!.textHash, contentHash(summary), 'and the hash of its text');
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
      t.equal(second.summaryVecsWritten, 1, 'of the summary vector');
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
      readonly retained = false;
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
      async releaseRetained(): Promise<void> {}
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
        .prepare(
          `SELECT v.embedding AS embedding
             FROM chunks c JOIN record_vec v ON v.chunk_id = c.chunk_id
            WHERE c.record_id = ?`
        )
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

class CountingEmbedder implements Embedder {
  readonly dim = 384;
  readonly modelName = 'counting-fake';
  readonly retained = false;
  readonly inner = new FakeEmbedder();
  readonly embedded: string[] = [];
  poison: (text: string) => boolean = () => false;
  beforeBatch: (texts: string[]) => void = () => {};

  async embed(text: string): Promise<Float32Array> {
    return (await this.embedBatch([text]))[0]!;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.beforeBatch(texts);
    this.embedded.push(...texts);
    const out = await this.inner.embedBatch(texts);
    return out.map((v, i) => (this.poison(texts[i]!) ? new Float32Array(v.length).fill(NaN) : v));
  }

  async releaseRetained(): Promise<void> {}
}

const longBody = (sections: number): string =>
  Array.from(
    {length: sections},
    (_, s) =>
      `## Section ${s}\n\n` +
      Array.from({length: 3}, (_, p) => `Paragraph ${s}.${p} ${'text '.repeat(90)}`).join('\n\n')
  ).join('\n\n');

const storedHashes = (db: DatabaseSync, recordId: string): (string | null)[] =>
  (
    db
      .prepare('SELECT text_hash FROM chunks WHERE record_id = ? ORDER BY chunk_index')
      .all(recordId) as {text_hash: string | null}[]
  ).map(r => r.text_hash);

test('embedPending reuses the vectors of unchanged chunks', async t => {
  await t.test('an append re-embeds only the chunk it changed', async t => {
    const fx = setup();
    const embedder = new CountingEmbedder();
    try {
      const body = longBody(6);
      const a = makeRecord('topics/long.md', body);
      fx.records.insert(a);
      const first = await embedPending(fx.db, embedder);
      const chunks = fx.vecs.getChunks(a.recordId).length;
      t.ok(chunks > 6, `the body spans several chunks (${chunks})`);
      t.equal(first.chunksReused, 0, 'nothing to reuse on the first pass');
      t.equal(embedder.embedded.length, chunks, 'every chunk embedded once');
      t.deepEqual(
        storedHashes(fx.db, a.recordId),
        chunkBody(body).map(text => contentHash(text)),
        'each chunk stores the hash of its text'
      );
      const before = fx.vecs.getChunks(a.recordId).map(v => Array.from(v));

      embedder.embedded.length = 0;
      const appended = `${body}\n\nOne more paragraph at the end.`;
      fx.records.upsertByPath({...a, body: appended, contentHash: contentHash(appended)});
      const second = await embedPending(fx.db, embedder);
      t.equal(second.embedded, 1, 'the record was re-embedded');
      t.equal(embedder.embedded.length, 1, 'one chunk text went to the model');
      t.equal(second.chunksReused, chunks - 1, 'every other chunk reused');
      const after = fx.vecs.getChunks(a.recordId).map(v => Array.from(v));
      t.deepEqual(after.slice(0, -1), before.slice(0, -1), 'reused vectors unchanged');
      t.equal(fx.vecs.getRecordContentHash(a.recordId), contentHash(appended), 'new hash recorded');
    } finally {
      fx.db.close();
    }
  });

  await t.test('a summary change embeds the summary and reuses every chunk', async t => {
    const fx = setup();
    const embedder = new CountingEmbedder();
    try {
      const body = longBody(4);
      const a = {...makeRecord('topics/long.md', body), agentSummary: 'first summary'};
      a.contentHash = embedInputHash(body, a.agentSummary);
      fx.records.insert(a);
      await embedPending(fx.db, embedder);
      const chunks = chunkBody(body).length;
      t.equal(
        embedder.embedded.length,
        chunks + 1,
        'the first pass embeds every chunk and the summary'
      );

      embedder.embedded.length = 0;
      const refreshed = {
        ...a,
        agentSummary: 'second summary',
        contentHash: embedInputHash(body, 'second summary')
      };
      fx.records.upsertByPath(refreshed);
      const second = await embedPending(fx.db, embedder);
      t.deepEqual(embedder.embedded, ['second summary'], 'only the new summary went to the model');
      t.equal(second.chunksReused, chunks, 'every chunk reused');
      t.equal(
        fx.vecs.getRecordContentHash(a.recordId),
        refreshed.contentHash,
        'the chunks carry the new content_hash'
      );
    } finally {
      fx.db.close();
    }
  });

  await t.test('a record whose summary vector is missing is pending', async t => {
    const fx = setup();
    const embedder = new CountingEmbedder();
    try {
      const body = longBody(2);
      const a = {...makeRecord('topics/long.md', body), agentSummary: 'the summary'};
      a.contentHash = embedInputHash(body, a.agentSummary);
      fx.records.insert(a);
      await embedPending(fx.db, embedder);
      new RecordSummaryVecRepository(fx.db).delete(a.recordId);

      embedder.embedded.length = 0;
      const pass = await embedPending(fx.db, embedder);
      t.equal(pass.embedded, 1, 'the record is picked up again');
      t.deepEqual(embedder.embedded, ['the summary'], 'and only its summary is embedded');
    } finally {
      fx.db.close();
    }
  });

  await t.test('removing the summary removes its vector', async t => {
    const fx = setup();
    try {
      const body = 'body';
      const a = {...makeRecord('topics/a.md', body), agentSummary: 'the summary'};
      a.contentHash = embedInputHash(body, a.agentSummary);
      fx.records.insert(a);
      await embedPending(fx.db, fx.embedder);
      fx.records.upsertByPath({...a, agentSummary: null, contentHash: contentHash(body)});
      await embedPending(fx.db, fx.embedder);
      t.equal(
        new RecordSummaryVecRepository(fx.db).get(a.recordId),
        null,
        'no summary vector left'
      );
    } finally {
      fx.db.close();
    }
  });

  await t.test('a non-finite summary vector does not keep its record pending', async t => {
    const fx = setup();
    const embedder = new CountingEmbedder();
    try {
      const body = 'body';
      const a = {...makeRecord('topics/a.md', body), agentSummary: 'poisoned summary'};
      a.contentHash = embedInputHash(body, a.agentSummary);
      fx.records.insert(a);
      embedder.poison = text => text === 'poisoned summary';
      await embedPending(fx.db, embedder);
      const stored = new RecordSummaryVecRepository(fx.db).get(a.recordId);
      t.equal(stored?.textHash, null, 'stored without a text hash, so never reused');

      const again = await embedPending(fx.db, embedder);
      t.equal(again.embedded, 0, 'the next pass finds nothing pending');
    } finally {
      fx.db.close();
    }
  });

  await t.test('a dropped non-finite vector keeps the remaining hashes paired', async t => {
    const fx = setup();
    const embedder = new CountingEmbedder();
    try {
      const body = longBody(3);
      const texts = chunkBody(body);
      const bad = texts[1]!;
      embedder.poison = text => text === bad;
      const a = makeRecord('topics/long.md', body);
      fx.records.insert(a);
      await embedPending(fx.db, embedder);
      const expected = texts.filter(text => text !== bad).map(text => contentHash(text));
      t.deepEqual(storedHashes(fx.db, a.recordId), expected, 'hashes follow the kept vectors');

      embedder.poison = () => false;
      embedder.embedded.length = 0;
      const edited = `${body}\n\nAppended.`;
      fx.records.upsertByPath({...a, body: edited, contentHash: contentHash(edited)});
      await embedPending(fx.db, embedder);
      t.ok(embedder.embedded.includes(bad), 'the chunk with no stored vector is embedded again');
      t.equal(embedder.embedded.length, 2, 'it and the appended chunk, nothing else');
    } finally {
      fx.db.close();
    }
  });
});

test('backfillChunkTextHashes fills hashes for chunk sets that still match their record', async t => {
  const fx = setup();
  const embedder = new CountingEmbedder();
  try {
    const bodyA = longBody(3);
    const a = makeRecord('topics/a.md', bodyA);
    const b = makeRecord('topics/b.md', longBody(2).replaceAll('Paragraph', 'Line'));
    fx.records.insert(a);
    fx.records.insert(b);
    // Embedded before 0023: chunks without text hashes.
    const vecsA = await embedder.inner.embedBatch(chunkBody(bodyA));
    fx.vecs.setChunks(a.recordId, a.contentHash, vecsA);
    fx.vecs.setChunks(b.recordId, 'an older body', [(await embedder.inner.embed('old'))!]);

    const summary = await backfillChunkTextHashes(fx.db);
    t.equal(summary.candidates, 2);
    t.equal(summary.written, 1, 'the matching record is filled');
    t.equal(summary.skipped, 1, 'the stale chunk set is left alone');
    t.deepEqual(
      storedHashes(fx.db, a.recordId),
      chunkBody(bodyA).map(text => contentHash(text)),
      'hashes follow chunk order'
    );
    t.deepEqual(storedHashes(fx.db, b.recordId), [null], 'stale record untouched');

    const again = await backfillChunkTextHashes(fx.db);
    t.equal(again.written, 0, 'idempotent');

    const edited = `${bodyA}\n\nAppended.`;
    fx.records.upsertByPath({...a, body: edited, contentHash: contentHash(edited)});
    embedder.embedded.length = 0;
    await embedPending(fx.db, embedder);
    t.equal(
      embedder.embedded.filter(text => chunkBody(edited).includes(text)).length,
      1,
      'the backfilled record reuses its unchanged chunks on the next edit'
    );
  } finally {
    fx.db.close();
  }
});

test('embedPending: overlapping passes on one database run one at a time', async t => {
  const fx = setup();
  const embedder = new CountingEmbedder();
  try {
    fx.records.insert(makeRecord('topics/a.md', longBody(3)));
    fx.records.insert(makeRecord('topics/b.md', longBody(2).replaceAll('Paragraph', 'Line')));
    const [first, second] = await Promise.all([
      embedPending(fx.db, embedder),
      embedPending(fx.db, embedder)
    ]);
    t.equal(first.embedded, 2, 'the first pass embeds both records');
    t.equal(second.embedded, 0, 'the second pass starts after it and finds nothing pending');
    t.equal(
      new Set(embedder.embedded).size,
      embedder.embedded.length,
      'no chunk text embedded twice'
    );
  } finally {
    fx.db.close();
  }
});

const setModified = (db: DatabaseSync, recordId: string, at: string): void => {
  db.prepare('UPDATE records SET modified_at = ? WHERE record_id = ?').run(at, recordId);
};

test('embedPending with maxEmbeds runs one round', async t => {
  await t.test('stops after the record that reaches the budget and reports the rest', async t => {
    const fx = setup();
    const embedder = new CountingEmbedder();
    try {
      for (let i = 0; i < 3; ++i) fx.records.insert(makeRecord(`topics/${i}.md`, `body-${i}`));
      const first = await embedPending(fx.db, embedder, {maxEmbeds: 2});
      t.equal(first.embedded, 2, 'two single-chunk records fill the budget');
      t.equal(first.remaining, 1, 'one record left');
      t.equal(first.upToDate, 0, 'neither embedded nor remaining counts as up to date');
      const second = await embedPending(fx.db, embedder, {maxEmbeds: 2});
      t.equal(second.embedded, 1, 'the next round takes the rest');
      t.equal(second.remaining, 0, 'nothing left');
    } finally {
      fx.db.close();
    }
  });

  await t.test('takes the most recently modified record first', async t => {
    const fx = setup();
    const embedder = new CountingEmbedder();
    try {
      const old = makeRecord('topics/old.md', 'old body');
      const recent = makeRecord('topics/recent.md', 'recent body');
      fx.records.insert(old);
      fx.records.insert(recent);
      setModified(fx.db, old.recordId, '2026-09-15T10:00:00.000Z');
      setModified(fx.db, recent.recordId, '2026-09-15T09:00:00.000Z');
      await embedPending(fx.db, embedder, {maxEmbeds: 1});
      t.deepEqual(embedder.embedded, ['old body'], 'the later modified_at goes first');
    } finally {
      fx.db.close();
    }
  });

  await t.test('completes a record larger than the budget', async t => {
    const fx = setup();
    const embedder = new CountingEmbedder();
    try {
      const body = longBody(4);
      const a = makeRecord('topics/long.md', body);
      fx.records.insert(a);
      const round = await embedPending(fx.db, embedder, {maxEmbeds: 1});
      t.equal(round.embedded, 1, 'the record is embedded');
      t.equal(embedder.embedded.length, chunkBody(body).length, 'with every chunk');
      t.equal(round.remaining, 0, 'nothing left');
    } finally {
      fx.db.close();
    }
  });
});

test('embedAllPending lets another pass run between its rounds', async t => {
  const fx = setup();
  const embedder = new CountingEmbedder();
  try {
    for (let i = 0; i < 4; ++i) {
      const r = makeRecord(`topics/${i}.md`, `backlog-${i}`);
      fx.records.insert(r);
      setModified(fx.db, r.recordId, `2026-09-15T0${i}:00:00.000Z`);
    }
    let drain: Promise<unknown> | null = null;
    embedder.beforeBatch = () => {
      if (drain) return;
      const edit = makeRecord('topics/edit.md', 'the edit');
      fx.records.insert(edit);
      setModified(fx.db, edit.recordId, '2026-09-15T12:00:00.000Z');
      drain = embedPending(fx.db, embedder, {maxEmbeds: 1});
    };
    const all = await embedAllPending(fx.db, embedder, {maxEmbeds: 1});
    await drain;
    t.equal(embedder.embedded[1], 'the edit', 'the edit is embedded right after the first round');
    t.equal(all.embedded, 4, 'the backlog finishes');
    t.equal(all.remaining, 0, 'nothing left');
    t.equal(new Set(embedder.embedded).size, 5, 'no text embedded twice');
  } finally {
    fx.db.close();
  }
});
