import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {
  l2Normalize,
  meanPoolNormalize,
  RecordDocVecRepository
} from '../src/db/doc-vec-repo.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {embedPending} from '../src/embeddings/embed-pass.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import {backfillDocVecs} from '../src/maintenance/backfill-doc-vecs.ts';

test('l2Normalize: normalizes a non-zero vector to unit length', t => {
  const v = new Float32Array([3, 4]);
  l2Normalize(v);
  t.ok(Math.abs(v[0]! - 0.6) < 1e-6, 'x ≈ 3/5');
  t.ok(Math.abs(v[1]! - 0.8) < 1e-6, 'y ≈ 4/5');
});

test('l2Normalize: zero vector passes through unchanged', t => {
  const v = new Float32Array([0, 0]);
  l2Normalize(v);
  t.equal(v[0], 0);
  t.equal(v[1], 0);
});

test('meanPoolNormalize: empty input returns null', t => {
  t.equal(meanPoolNormalize([]), null);
});

test('meanPoolNormalize: averages and renormalizes', t => {
  const a = new Float32Array([1, 0]);
  const b = new Float32Array([0, 1]);
  const pooled = meanPoolNormalize([a, b]);
  t.ok(pooled !== null);
  // mean = [0.5, 0.5]; ||mean|| = √0.5; normalize → [1/√2, 1/√2]
  const expected = 1 / Math.sqrt(2);
  t.ok(Math.abs(pooled![0]! - expected) < 1e-6);
  t.ok(Math.abs(pooled![1]! - expected) < 1e-6);
});

test('embedPending writes both chunk and doc vectors', async t => {
  const root = mkdtempSync(join(tmpdir(), 'doc-vec-embed-'));
  const db = openDatabase({path: ':memory:'});
  try {
    runMigrations(db);
    mkdirSync(join(root, 'topics'), {recursive: true});
    writeFileSync(join(root, 'topics/a.md'), '---\n---\nA body for embedding.\n');
    writeFileSync(join(root, 'topics/b.md'), '---\n---\nA different body for B.\n');
    importVault(db, root);
    const summary = await embedPending(db, new FakeEmbedder());
    t.equal(summary.embedded, 2, 'two records embedded');
    t.equal(summary.docVecsWritten, 2, 'two doc vectors written');

    const docs = new RecordDocVecRepository(db);
    t.equal(docs.countRecords(), 2, 'doc-vec table has both records');
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('backfillDocVecs computes doc vectors from existing chunks', async t => {
  const root = mkdtempSync(join(tmpdir(), 'doc-vec-backfill-'));
  const db = openDatabase({path: ':memory:'});
  try {
    runMigrations(db);
    mkdirSync(join(root, 'topics'), {recursive: true});
    writeFileSync(join(root, 'topics/a.md'), '---\n---\nA.\n');
    writeFileSync(join(root, 'topics/b.md'), '---\n---\nB.\n');
    importVault(db, root);
    await embedPending(db, new FakeEmbedder());

    // Simulate a pre-doc-vec DB by clearing record_doc_vec.
    db.exec('DELETE FROM record_doc_vec');
    const docs = new RecordDocVecRepository(db);
    t.equal(docs.countRecords(), 0, 'cleared');

    const summary = backfillDocVecs(db);
    t.equal(summary.candidates, 2);
    t.equal(summary.written, 2);
    t.equal(summary.upToDate, 0);
    t.equal(docs.countRecords(), 2, 'both records now have doc vecs');

    // Idempotency — second pass writes nothing.
    const second = backfillDocVecs(db);
    t.equal(second.written, 0);
    t.equal(second.upToDate, 2);
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('RecordDocVecRepository.nearestToRecord excludes self', async t => {
  const root = mkdtempSync(join(tmpdir(), 'doc-vec-nearest-'));
  const db = openDatabase({path: ':memory:'});
  try {
    runMigrations(db);
    mkdirSync(join(root, 'topics'), {recursive: true});
    writeFileSync(join(root, 'topics/a.md'), '---\n---\nA body for nearest test.\n');
    writeFileSync(join(root, 'topics/b.md'), '---\n---\nA body for nearest test.\n'); // identical
    writeFileSync(join(root, 'topics/c.md'), '---\n---\nUnrelated content for C.\n');
    importVault(db, root);
    await embedPending(db, new FakeEmbedder());

    const docs = new RecordDocVecRepository(db);
    const aId = (
      db.prepare(`SELECT record_id FROM records WHERE file_path = 'topics/a.md'`).get() as {
        record_id: string;
      }
    ).record_id;
    const hits = docs.nearestToRecord(aId, 5);
    t.ok(hits.every(h => h.recordId !== aId), 'self excluded from results');
    t.ok(hits.length >= 1, 'finds at least the identical-body neighbor');
    t.ok(hits[0]!.distance < 0.01, 'identical-body neighbor at distance ≈ 0');
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});
