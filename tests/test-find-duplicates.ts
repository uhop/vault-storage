import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {embedPending} from '../src/embeddings/embed-pass.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import {findDuplicates} from '../src/maintenance/find-duplicates.ts';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), 'find-dups-test-'));
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  return {root, db};
};

const teardown = ({root, db}: {root: string; db: ReturnType<typeof openDatabase>}) => {
  db.close();
  rmSync(root, {recursive: true, force: true});
};

test('findDuplicates files suggestions for high-similarity pairs', async t => {
  const fx = await setup();
  try {
    // Two notes with IDENTICAL bodies — FakeEmbedder gives them distance 0.
    // A third note with distinct content — distance ~1 from the others.
    const sharedBody = 'Pattern for handling X via the Y trick.';
    writeMd(fx.root, 'topics/a.md', `---\ntitle: A\n---\n${sharedBody}\n`);
    writeMd(fx.root, 'topics/b.md', `---\ntitle: B\n---\n${sharedBody}\n`);
    writeMd(fx.root, 'topics/c.md', '---\ntitle: C\n---\nUnrelated content here.\n');

    importVault(fx.db, fx.root);
    await embedPending(fx.db, new FakeEmbedder());

    const summary = findDuplicates(fx.db, {maxDistance: 0.1, perRecord: 5, minBodyLength: 0});
    t.equal(summary.scanned, 3, 'all three records scanned');
    t.equal(summary.skippedUnembedded, 0, 'all embedded');
    t.equal(summary.pairsFound, 1, 'A↔B is the only pair under threshold');
    t.equal(summary.filed, 1, 'one suggestion filed');

    const rows = fx.db
      .prepare(`SELECT payload, status FROM suggestions WHERE kind = 'duplicate'`)
      .all() as Array<{payload: string; status: string}>;
    t.equal(rows.length, 1, 'exactly one duplicate suggestion in DB');
    t.equal(rows[0]?.status, 'pending');
    const payload = JSON.parse(rows[0]!.payload) as {
      a_record: string;
      b_record: string;
      a_path: string;
      b_path: string;
      distance: number;
    };
    t.ok(
      (payload.a_path === 'topics/a.md' && payload.b_path === 'topics/b.md') ||
        (payload.a_path === 'topics/b.md' && payload.b_path === 'topics/a.md'),
      'payload covers the A↔B pair'
    );
    // Numeric-finite check first: `null < 0.001` is true under JS coercion
    // (null → 0), so a typeof-check is the only thing that catches the
    // real-world `distance: null` regression seen 2026-05-03.
    t.equal(typeof payload.distance, 'number', 'distance persisted as a number');
    t.ok(Number.isFinite(payload.distance), 'distance is a finite number');
    t.ok(payload.distance < 0.001, 'distance ≈ 0 for identical bodies');
  } finally {
    teardown(fx);
  }
});

test('findDuplicates is idempotent across runs', async t => {
  const fx = await setup();
  try {
    const shared = 'Same body, two notes.';
    writeMd(fx.root, 'a.md', `---\n---\n${shared}\n`);
    writeMd(fx.root, 'b.md', `---\n---\n${shared}\n`);
    importVault(fx.db, fx.root);
    await embedPending(fx.db, new FakeEmbedder());

    const first = findDuplicates(fx.db, {maxDistance: 0.1, minBodyLength: 0});
    t.equal(first.filed, 1);

    const second = findDuplicates(fx.db, {maxDistance: 0.1, minBodyLength: 0});
    t.equal(second.pairsFound, 1, 'pair still found');
    t.equal(second.filed, 0, 'no new suggestion filed (existing covers the pair)');

    const total = (
      fx.db.prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE kind = 'duplicate'`).get() as {
        n: number;
      }
    ).n;
    t.equal(total, 1, 'still exactly one suggestion');
  } finally {
    teardown(fx);
  }
});

test('findDuplicates respects maxDistance threshold', async t => {
  const fx = await setup();
  try {
    // All three notes distinct → FakeEmbedder gives mutual distances ≈ 1.
    writeMd(fx.root, 'a.md', '---\n---\nFirst note about apples.\n');
    writeMd(fx.root, 'b.md', '---\n---\nSecond note about bicycles.\n');
    writeMd(fx.root, 'c.md', '---\n---\nThird note about clarinets.\n');
    importVault(fx.db, fx.root);
    await embedPending(fx.db, new FakeEmbedder());

    const summary = findDuplicates(fx.db, {maxDistance: 0.1, minBodyLength: 0});
    t.equal(summary.pairsFound, 0, 'no pairs under tight threshold');
    t.equal(summary.filed, 0, 'nothing to file');
  } finally {
    teardown(fx);
  }
});

test('findDuplicates skips unembedded records cleanly', async t => {
  const fx = await setup();
  try {
    writeMd(fx.root, 'a.md', '---\n---\nA body.\n');
    writeMd(fx.root, 'b.md', '---\n---\nA body.\n'); // would dup
    importVault(fx.db, fx.root);
    // Skip embedPending — records exist but have no chunks in record_vec.

    const summary = findDuplicates(fx.db, {maxDistance: 0.1, minBodyLength: 0});
    t.equal(summary.scanned, 0);
    t.equal(summary.skippedUnembedded, 2);
    t.equal(summary.filed, 0);
  } finally {
    teardown(fx);
  }
});

test('findDuplicates honors limit cap', async t => {
  const fx = await setup();
  try {
    // Three identical-body pairs by writing six identical-body notes.
    const body = 'common body across many notes';
    for (const name of ['a', 'b', 'c', 'd']) {
      writeMd(fx.root, `${name}.md`, `---\n---\n${body}\n`);
    }
    importVault(fx.db, fx.root);
    await embedPending(fx.db, new FakeEmbedder());

    // Without limit: 4 records pairwise → C(4,2) = 6 pairs.
    const unlimited = findDuplicates(fx.db, {maxDistance: 0.1, minBodyLength: 0});
    t.equal(unlimited.filed, 6, 'all pairs filed');

    // Reset suggestions and re-run with limit.
    fx.db.exec(`DELETE FROM suggestions WHERE kind = 'duplicate'`);
    const capped = findDuplicates(fx.db, {maxDistance: 0.1, minBodyLength: 0, limit: 3});
    t.equal(capped.filed, 3, 'capped at limit');
  } finally {
    teardown(fx);
  }
});

// Body-length / type / path filters introduced after the initial scan on the
// live vault surfaced 12 false-positive pairs caused by short boilerplate
// bodies (state.md, empty queue.md, sync logs). The filters keep the queue
// signal-rich.

test('findDuplicates skips records with bodies under minBodyLength', async t => {
  const fx = await setup();
  try {
    const shortBody = 'tiny';
    writeMd(fx.root, 'a.md', `---\n---\n${shortBody}\n`);
    writeMd(fx.root, 'b.md', `---\n---\n${shortBody}\n`);
    importVault(fx.db, fx.root);
    await embedPending(fx.db, new FakeEmbedder());

    // Default minBodyLength = 200: both records skipped, no pair filed.
    const filtered = findDuplicates(fx.db, {maxDistance: 0.1});
    t.equal(filtered.skippedShort, 2, 'both records skipped as too-short');
    t.equal(filtered.scanned, 0, 'no record scanned');
    t.equal(filtered.filed, 0, 'no pair filed');

    // With minBodyLength = 0 the same fixture finds the pair.
    const allowed = findDuplicates(fx.db, {maxDistance: 0.1, minBodyLength: 0});
    t.equal(allowed.filed, 1, 'with filter disabled, the pair is filed');
  } finally {
    teardown(fx);
  }
});

test('findDuplicates skips records of skipped types', async t => {
  const fx = await setup();
  try {
    // Two state.md files with identical bodies — exactly the live-vault false
    // positive pattern (vault-check-drift writes boilerplate state.md).
    const stateBody =
      'A long enough body to clear minBodyLength but still be a state.md ' +
      'file that should not be treated as conceptually duplicate.';
    writeMd(
      fx.root,
      'projects/x/state.md',
      `---\ntype: state\n---\n${stateBody}\n${stateBody}\n${stateBody}\n`
    );
    writeMd(
      fx.root,
      'projects/y/state.md',
      `---\ntype: state\n---\n${stateBody}\n${stateBody}\n${stateBody}\n`
    );
    importVault(fx.db, fx.root);
    await embedPending(fx.db, new FakeEmbedder());

    const summary = findDuplicates(fx.db, {maxDistance: 0.1, minBodyLength: 0});
    t.equal(summary.skippedByType, 2, 'both state.md records skipped by type');
    t.equal(summary.filed, 0, 'no suggestion filed');
  } finally {
    teardown(fx);
  }
});

test('findDuplicates skips records under skipPathPrefixes', async t => {
  const fx = await setup();
  try {
    const body =
      'A long enough body to clear minBodyLength threshold; ' +
      'this is a sync-pass log entry that happened to look identical to another.';
    writeMd(fx.root, 'logs/sync/2026-04-29.md', `---\ntype: log\n---\n${body}\n${body}\n${body}\n`);
    writeMd(fx.root, 'logs/sync/2026-04-30.md', `---\ntype: log\n---\n${body}\n${body}\n${body}\n`);
    importVault(fx.db, fx.root);
    await embedPending(fx.db, new FakeEmbedder());

    const summary = findDuplicates(fx.db, {maxDistance: 0.1, minBodyLength: 0});
    t.equal(summary.skippedByPath, 2, 'both sync logs skipped by path prefix');
    t.equal(summary.filed, 0);
  } finally {
    teardown(fx);
  }
});
