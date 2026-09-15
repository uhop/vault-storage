import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {embedPending} from '../src/embeddings/embed-pass.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import type {Embedder} from '../src/embeddings/types.ts';
import {importVault} from '../src/importer/import.ts';
import {findDuplicateBlockers, proposeNearest} from '../src/maintenance/propose.ts';
import {RecordsRepository} from '../src/records/repository.ts';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

// Each section clears the chunker's 1200-char soft target on its own, so a
// multi-section note embeds as several independent vectors rather than one
// blended chunk. That separation is the whole point of the fixture: under
// FakeEmbedder distinct texts are near-orthogonal, so a note built from four
// sections has a centroid far from any one of them while still holding a
// chunk identical to the short note's.
const section = (label: string): string =>
  `Section ${label}. ` +
  `Filler sentence number ${label} carrying enough words to push this paragraph past the soft chunk target. `.repeat(
    14
  );

const SHARED = section('S');
const LONG = [SHARED, section('1'), section('2'), section('3')].join('\n\n');
const UNRELATED = section('U');

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'propose-test-'));
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  writeMd(root, 'topics/short.md', `---\ntitle: Short\ntype: permanent\n---\n${SHARED}\n`);
  writeMd(root, 'topics/long.md', `---\ntitle: Long\ntype: permanent\n---\n${LONG}\n`);
  writeMd(root, 'topics/other.md', `---\ntitle: Other\ntype: permanent\n---\n${UNRELATED}\n`);
  importVault(db, root);
  await embedPending(db, new FakeEmbedder());
  return {root, db, embedder: new FakeEmbedder()};
};

const teardown = ({root, db}: {root: string; db: ReturnType<typeof openDatabase>}) => {
  db.close();
  rmSync(root, {recursive: true, force: true});
};

const pathsOf = (r: {candidates: {filePath: string}[]}) => r.candidates.map(c => c.filePath);

test('proposeNearest finds a long note that matches on a single section', async t => {
  const fx = await setup();
  try {
    const r = await proposeNearest(fx.db, fx.embedder, SHARED);

    // The regression this pins: topics/long.md holds a chunk identical to the
    // proposal, but its mean-pool centroid is smeared across four
    // near-orthogonal sections. The doc-level prefilter removed 2026-08-03
    // screened exactly this case out — it assumed the centroid lower-bounds
    // the chunk-pair distance, which mean-pooling does not guarantee.
    const long = r.candidates.find(c => c.filePath === 'topics/long.md');
    t.ok(long, 'the long note is returned despite a distant centroid');
    t.ok(long!.distance < 1e-6, 'matched on its identical chunk, at distance ~0');

    const short = r.candidates.find(c => c.filePath === 'topics/short.md');
    t.ok(short, 'the short note is returned too');
    t.ok(short!.distance < 1e-6, 'short note at distance ~0');

    t.equal(r.candidatesScreened, 3, 'every record holding chunks was compared');
    t.equal(r.maxDistance, Infinity, 'uncapped by default');

    const distances = r.candidates.map(c => c.distance);
    t.deepEqual(
      distances,
      [...distances].sort((a, b) => a - b),
      'sorted by ascending distance'
    );
  } finally {
    teardown(fx);
  }
});

test('proposeNearest maxDistance filters the metric it reports', async t => {
  const fx = await setup();
  try {
    await t.test('uncapped returns the unrelated note as well', async t => {
      const r = await proposeNearest(fx.db, fx.embedder, SHARED);
      t.ok(pathsOf(r).includes('topics/other.md'), 'unrelated note present when uncapped');
      const other = r.candidates.find(c => c.filePath === 'topics/other.md');
      t.ok(other!.distance > 0.5, 'and it really is far away');
    });

    await t.test('a cap drops everything above it', async t => {
      const r = await proposeNearest(fx.db, fx.embedder, SHARED, {maxDistance: 0.5});
      t.deepEqual(
        pathsOf(r).sort(),
        ['topics/long.md', 'topics/short.md'],
        'only the two near notes survive'
      );
      t.equal(r.maxDistance, 0.5, 'the applied cap is echoed back');
      t.equal(r.candidatesScreened, 3, 'screening count is comparisons made, not results kept');
    });

    await t.test('a cap below every distance yields nothing, not an error', async t => {
      const r = await proposeNearest(fx.db, fx.embedder, UNRELATED, {maxDistance: 1e-9});
      t.deepEqual(pathsOf(r), [], 'no candidates');
      t.equal(r.candidatesScreened, 3, 'still compared everything — the emptiness is real');
    });
  } finally {
    teardown(fx);
  }
});

test('proposeNearest excludeRecordId drops the self-match', async t => {
  const fx = await setup();
  try {
    const records = new RecordsRepository(fx.db);
    const shortRec = records.getByPath('topics/short.md');
    t.ok(shortRec, 'fixture record resolved');

    const r = await proposeNearest(fx.db, fx.embedder, SHARED, {
      excludeRecordId: shortRec!.recordId
    });
    t.notOk(pathsOf(r).includes('topics/short.md'), 'excluded record absent');
    t.ok(pathsOf(r).includes('topics/long.md'), 'other near note still present');
    t.equal(r.candidatesScreened, 2, 'excluded record is not counted as compared');
  } finally {
    teardown(fx);
  }
});

// Characterization, not endorsement: a whitespace-only body embeds like any
// other string and returns its nearest neighbours at meaningless distances.
// Rejecting degenerate input is the HTTP layer's job (`body must be a
// non-empty string`), and whitespace slips past that as a non-empty string.
// Pinned so that tightening it later is a deliberate, visible change.
test('proposeNearest does not special-case a whitespace-only body', async t => {
  const fx = await setup();
  try {
    const r = await proposeNearest(fx.db, fx.embedder, '   ');
    t.equal(r.proposedChunks, 1, 'whitespace still chunks and embeds');
    t.equal(r.candidatesScreened, 3, 'and is compared against everything');
    t.ok(
      r.candidates.every(c => c.distance > 0.5),
      'every "match" is far away — garbage in, garbage out'
    );
  } finally {
    teardown(fx);
  }
});

// --- findDuplicateBlockers -------------------------------------------------

// FakeEmbedder hashes the whole string, so any two distinct texts sit
// near-orthogonal. A bag-of-words embedder gives partial overlap a partial
// distance, which the decoy below needs.
class BagOfWordsEmbedder implements Embedder {
  // 384 to match the vec0 column width the schema fixes for embeddings.
  readonly dim = 384;
  readonly modelName = 'bag-of-words-test';
  readonly retained = false;
  readonly embedded: string[] = [];

  async embed(text: string): Promise<Float32Array> {
    return (await this.embedBatch([text]))[0]!;
  }
  embedQuery(text: string): Promise<Float32Array> {
    return this.embed(text);
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    this.embedded.push(...texts);
    return texts.map(t => this.#vec(t));
  }
  async releaseRetained(): Promise<void> {}

  #vec(text: string): Float32Array {
    const vec = new Float32Array(this.dim);
    for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (!word) continue;
      let h = 2166136261;
      for (let i = 0; i < word.length; ++i) {
        h ^= word.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      vec[(h >>> 0) % this.dim]! += 1;
    }
    let norm = 0;
    for (const x of vec) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm > 0) for (let i = 0; i < this.dim; ++i) vec[i]! /= norm;
    return vec;
  }
}

const DEC_BODY =
  'Pattern for handling retry storms via careful queue management. ' +
  'The consumer drains steadily once the window exceeds the interval and the workers settle. '.repeat(
    2
  );
const DEC_SUMMARY =
  'Retry storms tamed by exponential backoff with jitter sized above the retry interval, drained predictably. '.repeat(
    2
  );
// Overlaps DEC_BODY on purpose, and carries the same summary: close enough to
// be a neighbour, far enough (≈ 0.19) not to be a duplicate.
const DEC_DECOY =
  'The consumer drains steadily once the window exceeds the interval and the workers settle. '.repeat(
    3
  ) +
  'Glacier terminus retreat measured by photogrammetry across successive melt seasons in coastal fjords. '.repeat(
    3
  );
const DEC_OTHER =
  'Glacier terminus retreat measured by photogrammetry across successive melt seasons in coastal fjords. '.repeat(
    4
  );
const DEC_NOVEL =
  'Tomato cultivation in raised beds depends on mulch composition and drip irrigation tubing diameter. '.repeat(
    4
  );

const decSetup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'propose-dedup-'));
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  writeMd(
    root,
    'topics/decorated.md',
    `---\ntitle: Decorated\ntype: permanent\nagent:\n  summary: "${DEC_SUMMARY.trim()}"\n---\n${DEC_BODY}\n`
  );
  writeMd(
    root,
    'topics/decorated-unrelated.md',
    `---\ntitle: Decorated unrelated\ntype: permanent\nagent:\n  summary: "${DEC_SUMMARY.trim()}"\n---\n${DEC_DECOY}\n`
  );
  writeMd(root, 'topics/plain.md', `---\ntitle: Plain\ntype: permanent\n---\n${DEC_OTHER}\n`);
  importVault(db, root);
  const embedder = new BagOfWordsEmbedder();
  await embedPending(db, embedder);
  return {root, db, embedder};
};

test('findDuplicateBlockers catches a verbatim copy of a summarized note', async t => {
  const fx = await decSetup();
  try {
    fx.embedder.embedded.length = 0;
    const blockers = await findDuplicateBlockers(fx.db, fx.embedder, DEC_BODY, {threshold: 0.1});
    t.deepEqual(
      blockers.map(b => b.filePath),
      ['topics/decorated.md'],
      'exactly one blocker, the summarized twin'
    );
    t.ok(blockers[0]!.distance < 1e-6, `at distance ${blockers[0]!.distance.toFixed(4)}`);
    t.deepEqual(fx.embedder.embedded, [DEC_BODY], 'only the proposal was embedded');
  } finally {
    teardown(fx);
  }
});

test('findDuplicateBlockers does not block on a note that shares only its summary', async t => {
  const fx = await decSetup();
  try {
    const nearest = await proposeNearest(fx.db, fx.embedder, DEC_BODY, {maxDistance: 0.25});
    const decoy = nearest.candidates.find(c => c.filePath === 'topics/decorated-unrelated.md');
    t.ok(decoy, 'the decoy is a neighbour');
    t.ok(decoy!.distance > 0.1, `above the gate at ${decoy!.distance.toFixed(4)}`);

    const blockers = await findDuplicateBlockers(fx.db, fx.embedder, DEC_BODY, {threshold: 0.1});
    t.notOk(
      blockers.some(b => b.filePath === 'topics/decorated-unrelated.md'),
      'sharing a summary does not make it a duplicate'
    );
  } finally {
    teardown(fx);
  }
});

test('findDuplicateBlockers does not invent blockers for unrelated content', async t => {
  const fx = await decSetup();
  try {
    const blockers = await findDuplicateBlockers(fx.db, fx.embedder, DEC_NOVEL, {
      threshold: 0.1
    });
    t.deepEqual(
      blockers.map(b => b.filePath),
      [],
      'nothing within the threshold'
    );
  } finally {
    teardown(fx);
  }
});

test('findDuplicateBlockers catches a verbatim copy of a note without a summary', async t => {
  const fx = await decSetup();
  try {
    const blockers = await findDuplicateBlockers(fx.db, fx.embedder, DEC_OTHER, {threshold: 0.1});
    t.deepEqual(
      blockers.map(b => b.filePath),
      ['topics/plain.md'],
      'the right record'
    );
    t.ok(blockers[0]!.distance < 1e-6, 'at distance ~0');
  } finally {
    teardown(fx);
  }
});

test('findDuplicateBlockers respects excludeRecordId on an in-place rewrite', async t => {
  const fx = await decSetup();
  try {
    const rec = new RecordsRepository(fx.db).getByPath('topics/decorated.md');
    const blockers = await findDuplicateBlockers(fx.db, fx.embedder, DEC_BODY, {
      threshold: 0.1,
      excludeRecordId: rec!.recordId
    });
    t.deepEqual(
      blockers.map(b => b.filePath),
      [],
      'a note does not block a rewrite of itself'
    );
  } finally {
    teardown(fx);
  }
});
