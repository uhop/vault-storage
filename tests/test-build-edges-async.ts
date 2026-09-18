import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {buildEdges, buildEdgesAsync} from '../src/importer/build-edges.ts';
import {importFile} from '../src/importer/import-file.ts';
import {importVault} from '../src/importer/import.ts';
import {EdgesRepository} from '../src/records/edges.ts';
import {RecordsRepository} from '../src/records/repository.ts';

interface Fixture {
  root: string;
  db: DatabaseSync;
  records: RecordsRepository;
  edges: EdgesRepository;
}

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const note = (title: string, body: string, fm = ''): string =>
  `---\ntitle: ${title}\n${fm}---\n${body}\n`;

// Sorted by path, which is the order the pass walks: batch 1 is `a`.
const VAULT: Record<string, string> = {
  'topics/a.md': note(
    'A',
    'Cites [[topics/b]] and [[topics/c]].',
    'related:\n  - "[[topics/d]]"\n'
  ),
  'topics/b.md': note('B', 'Superseded by [[topics/c]].'),
  'topics/c.md': note('C', 'Cites [[d]] by basename.'),
  'topics/d.md': note('D', 'Cites [[topics/a]].'),
  'topics/e.md': note('E', 'Cites [[topics/a]].', 'status: archived\n')
};

const setup = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'vault-edges-async-'));
  for (const [path, content] of Object.entries(VAULT)) writeMd(root, path, content);
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  importVault(db, root);
  return {root, db, records: new RecordsRepository(db), edges: new EdgesRepository(db)};
};

const teardown = ({root, db}: Fixture): void => {
  db.close();
  rmSync(root, {recursive: true, force: true});
};

const edgeSet = ({edges, records}: Fixture): string[] => {
  const path = (id: string): string => records.getById(id)?.filePath ?? id;
  return edges
    .listAll()
    .map(e => `${path(e.fromId)} ${e.type} ${path(e.toId)}`)
    .sort();
};

const id = (fx: Fixture, path: string): string => fx.records.getByPath(path)!.recordId;

/** The write path's shape: file on disk, import, then the scoped edge pass. */
const write = (fx: Fixture, path: string, content: string): void => {
  writeMd(fx.root, path, content);
  const {recordId} = importFile(fx.records, path, join(fx.root, path));
  buildEdges(fx.db, {vaultRoot: fx.root, scope: new Set([recordId])});
};

/** Run the yielding pass with `interleave` at yield number `at` (default: after the first record). */
const passWith = (fx: Fixture, interleave: () => void, {at = 1, batch = 1, gcPage = 1} = {}) => {
  let yields = 0;
  return buildEdgesAsync(fx.db, {
    vaultRoot: fx.root,
    batch,
    gcPage,
    yieldTo: async () => {
      if (++yields === at) interleave();
    }
  });
};

test('buildEdgesAsync: with nothing interleaved, the edges are the synchronous pass’s', async t => {
  const fx = setup();
  try {
    const synchronous = edgeSet(fx);
    t.ok(synchronous.length >= 6, `a non-trivial graph: ${synchronous.join('; ')}`);

    fx.db.exec('DELETE FROM edges');
    const rebuilt = await buildEdgesAsync(fx.db, {vaultRoot: fx.root, batch: 2});
    t.deepEqual(edgeSet(fx), synchronous, 'from an empty table, in batches of two');
    t.equal(rebuilt.archivedSkipped, 1);

    fx.edges.upsert({
      fromId: id(fx, 'topics/c.md'),
      toId: id(fx, 'topics/b.md'),
      type: 'cites',
      weight: 1,
      note: null,
      created: '2026-09-18T00:00:00Z'
    });
    const again = await buildEdgesAsync(fx.db, {vaultRoot: fx.root, batch: 2, gcPage: 1});
    t.deepEqual(edgeSet(fx), synchronous, 'an edge nothing backs is collected, one per GC page');
    t.equal(again.edgesDeleted, 1);
    t.equal(again.edgesSparedByWrites, 0, 'nothing wrote, so nothing is spared');
  } finally {
    teardown(fx);
  }
});

test('buildEdgesAsync: an edge a write adds to a record the pass already passed survives the GC', async t => {
  const fx = setup();
  try {
    const summary = await passWith(fx, () =>
      write(fx, 'topics/a.md', note('A', 'Cites [[topics/b]], [[topics/c]] and now [[topics/e]].'))
    );
    const edges = edgeSet(fx);
    t.ok(edges.includes('topics/a.md cites topics/e.md'), 'the written edge is kept');
    t.notOk(
      edges.includes('topics/a.md related-to topics/d.md'),
      'and the related: the write removed stays removed'
    );
    t.ok(summary.edgesSparedByWrites >= 1, `spared ${summary.edgesSparedByWrites}`);
  } finally {
    teardown(fx);
  }
});

test('buildEdgesAsync: an edge a write adds between two GC pages survives', async t => {
  const fx = setup();
  try {
    // One record batch (yield 1), then one edge per GC page: yield 2 falls inside the GC,
    // with the cursor on the smallest key. Ids order by time only to the millisecond, so
    // write to whichever record sorts last: its new edge is then ahead of the cursor.
    const [last] = ['topics/a.md', 'topics/b.md', 'topics/c.md', 'topics/d.md']
      .map(path => ({path, recordId: id(fx, path)}))
      .sort((x, y) => (x.recordId < y.recordId ? 1 : -1));
    const summary = await passWith(
      fx,
      () => write(fx, last!.path, `${VAULT[last!.path]!.trimEnd()} Also cites [[topics/e]].\n`),
      {at: 2, batch: 100}
    );
    t.ok(edgeSet(fx).includes(`${last!.path} cites topics/e.md`), 'the written edge is kept');
    t.ok(summary.edgesSparedByWrites >= 1, `spared ${summary.edgesSparedByWrites}`);
  } finally {
    teardown(fx);
  }
});

test('buildEdgesAsync: a record deleted between batches drops out without a foreign-key failure', async t => {
  const fx = setup();
  try {
    const d = id(fx, 'topics/d.md');
    const summary = await passWith(fx, () => {
      rmSync(join(fx.root, 'topics/d.md'));
      fx.records.delete(d);
    });
    const edges = edgeSet(fx);
    t.notOk(
      edges.some(e => e.includes(d) || e.includes('topics/d.md')),
      'no edge names the deleted record'
    );
    t.ok(summary.unresolvedBody >= 1, 'C’s [[d]] no longer resolves: the resolver saw the delete');
  } finally {
    teardown(fx);
  }
});

test('buildEdgesAsync: a record created between batches keeps its edges', async t => {
  const fx = setup();
  try {
    await passWith(fx, () => write(fx, 'topics/f.md', note('F', 'Cites [[topics/a]].')));
    t.ok(edgeSet(fx).includes('topics/f.md cites topics/a.md'));
  } finally {
    teardown(fx);
  }
});
