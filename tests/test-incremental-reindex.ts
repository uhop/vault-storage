import test from 'tape-six';
import {execSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {
  getLastIndexedCommit,
  incrementalReindex,
  setLastIndexedCommit
} from '../src/maintenance/incremental-reindex.ts';
import {QueueItemsRepository} from '../src/queue/repo.ts';
import {EdgesRepository} from '../src/records/edges.ts';
import {ImportFailuresRepository} from '../src/records/import-failures.ts';
import {RecordsRepository} from '../src/records/repository.ts';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const git = (cwd: string, args: string): string =>
  execSync(`git ${args}`, {cwd, stdio: ['ignore', 'pipe', 'ignore']})
    .toString()
    .trim();

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'incremental-reindex-test-'));
  // Initialize git repo with deterministic identity.
  git(root, 'init -b main');
  git(root, 'config user.name test');
  git(root, 'config user.email test@test');
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  return {root, db};
};

const teardown = ({root, db}: {root: string; db: ReturnType<typeof openDatabase>}) => {
  db.close();
  rmSync(root, {recursive: true, force: true});
};

test('incrementalReindex: bootstrap path runs full importVault and pins HEAD', async t => {
  const fx = setup();
  try {
    writeMd(fx.root, 'topics/a.md', '---\ntitle: A\n---\nbody A\n');
    writeMd(fx.root, 'topics/b.md', '---\ntitle: B\n---\nbody B\n');
    git(fx.root, 'add -A');
    git(fx.root, 'commit -m initial');
    const head = git(fx.root, 'rev-parse HEAD');

    const summary = await incrementalReindex(fx.db, fx.root);
    t.equal(summary.fellBack, true, 'no anchor → full import');
    t.equal(summary.toCommit, head);
    t.equal(getLastIndexedCommit(fx.db), head, 'anchor pinned at HEAD');

    const repo = new RecordsRepository(fx.db);
    t.ok(repo.getByPath('topics/a.md'), 'A imported');
    t.ok(repo.getByPath('topics/b.md'), 'B imported');
  } finally {
    teardown(fx);
  }
});

test('incrementalReindex: no-op when HEAD matches anchor', async t => {
  const fx = setup();
  try {
    writeMd(fx.root, 'topics/a.md', '---\ntitle: A\n---\nbody A\n');
    git(fx.root, 'add -A');
    git(fx.root, 'commit -m initial');
    await incrementalReindex(fx.db, fx.root); // bootstrap

    const second = await incrementalReindex(fx.db, fx.root);
    t.equal(second.fellBack, false);
    t.equal(second.changedFiles, 0);
    t.equal(second.imported, 0);
    t.equal(second.deleted, 0);
  } finally {
    teardown(fx);
  }
});

test('incrementalReindex: dispatches modify / add / delete from a single diff range', async t => {
  const fx = setup();
  try {
    writeMd(fx.root, 'topics/keep.md', '---\ntitle: K\n---\noriginal keep\n');
    writeMd(fx.root, 'topics/modify.md', '---\ntitle: M\n---\noriginal modify\n');
    writeMd(fx.root, 'topics/delete.md', '---\ntitle: D\n---\nto be deleted\n');
    git(fx.root, 'add -A');
    git(fx.root, 'commit -m initial');
    await incrementalReindex(fx.db, fx.root); // bootstrap pins HEAD

    const repo = new RecordsRepository(fx.db);
    const modifiedId = repo.getByPath('topics/modify.md')?.recordId;
    const deletedId = repo.getByPath('topics/delete.md')?.recordId;
    t.ok(modifiedId);
    t.ok(deletedId);

    // Make changes: modify, add, delete.
    writeMd(fx.root, 'topics/modify.md', '---\ntitle: M\n---\nupdated body\n');
    writeMd(fx.root, 'topics/added.md', '---\ntitle: New\n---\nbrand new\n');
    rmSync(join(fx.root, 'topics/delete.md'));
    git(fx.root, 'add -A');
    git(fx.root, 'commit -m changes');

    const summary = await incrementalReindex(fx.db, fx.root);
    t.equal(summary.fellBack, false, 'incremental path');
    t.equal(summary.imported, 2, 'modify + add');
    t.equal(summary.deleted, 1, 'one delete');

    t.ok(repo.getByPath('topics/added.md'), 'added.md exists');
    t.equal(repo.getByPath('topics/modify.md')?.recordId, modifiedId, 'modify preserves record_id');
    t.equal(repo.getByPath('topics/delete.md'), null, 'delete.md gone');
  } finally {
    teardown(fx);
  }
});

test('incrementalReindex: rename preserves record_id', async t => {
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'topics/old.md',
      '---\ntitle: O\n---\nbody for rename test\nthis content stays the same so git detects it as a rename\n'
    );
    git(fx.root, 'add -A');
    git(fx.root, 'commit -m initial');
    await incrementalReindex(fx.db, fx.root);
    const repo = new RecordsRepository(fx.db);
    const originalId = repo.getByPath('topics/old.md')?.recordId;
    t.ok(originalId);

    // git mv preserves content for rename detection.
    git(fx.root, 'mv topics/old.md topics/new.md');
    git(fx.root, 'commit -m rename');

    const summary = await incrementalReindex(fx.db, fx.root);
    t.equal(summary.renamed, 1, 'one rename detected');
    t.equal(repo.getByPath('topics/old.md'), null, 'old path gone from records');
    t.equal(
      repo.getByPath('topics/new.md')?.recordId,
      originalId,
      'new path inherits the original record_id'
    );
  } finally {
    teardown(fx);
  }
});

test('incrementalReindex: queue slices follow the queue files through modify, rename, and delete', async t => {
  const fx = setup();
  try {
    const queue = (items: string[]): string =>
      `---\ntitle: Queue\ntype: project\n---\n## Backlog\n\n${items.map(i => `- **${i}.** x\n`).join('\n')}`;
    const slices = (): string[] =>
      new QueueItemsRepository(fx.db).listAll().map(r => `${r.source_file}: ${r.title}`);

    writeMd(fx.root, 'projects/alpha/queue.md', queue(['First']));
    git(fx.root, 'add -A');
    git(fx.root, 'commit -m initial');
    await incrementalReindex(fx.db, fx.root);
    t.deepEqual(slices(), ['projects/alpha/queue.md: First.'], 'the full import derives it');

    writeMd(fx.root, 'projects/alpha/queue.md', queue(['First', 'Second']));
    git(fx.root, 'commit -am modify');
    await incrementalReindex(fx.db, fx.root);
    t.deepEqual(
      slices(),
      ['projects/alpha/queue.md: First.', 'projects/alpha/queue.md: Second.'],
      'a modify'
    );

    mkdirSync(join(fx.root, 'projects/bravo'));
    git(fx.root, 'mv projects/alpha/queue.md projects/bravo/queue.md');
    git(fx.root, 'commit -m rename');
    await incrementalReindex(fx.db, fx.root);
    t.deepEqual(
      slices(),
      ['projects/bravo/queue.md: First.', 'projects/bravo/queue.md: Second.'],
      'a rename'
    );

    git(fx.root, 'rm -q projects/bravo/queue.md');
    git(fx.root, 'commit -m delete');
    await incrementalReindex(fx.db, fx.root);
    t.deepEqual(slices(), [], 'a delete');
  } finally {
    teardown(fx);
  }
});

test('incrementalReindex: history loss falls back to full import', async t => {
  const fx = setup();
  try {
    writeMd(fx.root, 'topics/a.md', '---\ntitle: A\n---\nv1\n');
    git(fx.root, 'add -A');
    git(fx.root, 'commit -m initial');
    await incrementalReindex(fx.db, fx.root); // anchor at v1

    // Set the anchor to a fictional SHA the repo doesn't have.
    setLastIndexedCommit(fx.db, '0'.repeat(40));

    writeMd(fx.root, 'topics/b.md', '---\ntitle: B\n---\nv2\n');
    git(fx.root, 'add -A');
    git(fx.root, 'commit -m more');

    const summary = await incrementalReindex(fx.db, fx.root);
    t.equal(summary.fellBack, true, 'invalid anchor → full path');

    const repo = new RecordsRepository(fx.db);
    t.ok(repo.getByPath('topics/a.md'));
    t.ok(repo.getByPath('topics/b.md'), 'full import picked up the new file');
  } finally {
    teardown(fx);
  }
});

test('incrementalReindex: skips non-md changes', async t => {
  const fx = setup();
  try {
    writeMd(fx.root, 'topics/a.md', '---\ntitle: A\n---\nbody\n');
    git(fx.root, 'add -A');
    git(fx.root, 'commit -m initial');
    await incrementalReindex(fx.db, fx.root);

    writeMd(fx.root, 'README.txt', 'not a markdown file\n');
    writeMd(fx.root, 'config.json', '{}\n');
    git(fx.root, 'add -A');
    git(fx.root, 'commit -m non-md');

    const summary = await incrementalReindex(fx.db, fx.root);
    t.equal(summary.changedFiles, 0, '.txt and .json are not counted');
    t.equal(summary.imported, 0);
  } finally {
    teardown(fx);
  }
});

test('incrementalReindex: workingTree imports uncommitted edits, new files, and deletions', async t => {
  const fx = setup();
  try {
    writeMd(fx.root, 'topics/a.md', '---\ntitle: A\n---\nbody A\n');
    writeMd(fx.root, 'topics/b.md', '---\ntitle: B\n---\nbody B\n');
    git(fx.root, 'add -A');
    git(fx.root, 'commit -m initial');
    await incrementalReindex(fx.db, fx.root); // bootstrap

    writeMd(fx.root, 'topics/a.md', '---\ntitle: A edited\n---\nbody A, edited while down\n');
    writeMd(fx.root, 'topics/c.md', '---\ntitle: C\n---\nbody C, never committed\n');
    rmSync(join(fx.root, 'topics/b.md'));

    const repo = new RecordsRepository(fx.db);
    const without = await incrementalReindex(fx.db, fx.root);
    t.equal(without.changedFiles, 0, 'without the option, a clean HEAD is a no-op');
    t.equal(repo.getByPath('topics/c.md'), null, 'untracked file not imported without the option');

    const summary = await incrementalReindex(fx.db, fx.root, {workingTree: true});
    t.equal(summary.fellBack, false, 'no full import');
    t.equal(summary.changedFiles, 3, 'three dirty .md paths');
    t.equal(repo.getByPath('topics/a.md')?.title, 'A edited', 'uncommitted edit imported');
    t.ok(repo.getByPath('topics/c.md'), 'untracked file imported');
    t.equal(repo.getByPath('topics/b.md'), null, 'deleted file removed');
    t.equal(summary.deleted, 1, 'one deletion counted');
  } finally {
    teardown(fx);
  }
});

test('incrementalReindex: concurrent calls on one database run one at a time', async t => {
  const fx = setup();
  try {
    writeMd(fx.root, 'topics/a.md', '---\ntitle: A\n---\nbody A\n');
    git(fx.root, 'add -A');
    git(fx.root, 'commit -m initial');

    const [first, second] = await Promise.all([
      incrementalReindex(fx.db, fx.root),
      incrementalReindex(fx.db, fx.root)
    ]);
    t.equal(first.fellBack, true, 'the first call bootstraps');
    t.equal(second.fellBack, false, 'the second call starts after the anchor is pinned');
    t.equal(
      second.fromCommit,
      first.toCommit,
      'the second call starts from the anchor the first one pinned'
    );
  } finally {
    teardown(fx);
  }
});

test('incrementalReindex: workingTree keeps a staged rename record id and drops a rename away from .md', async t => {
  const fx = setup();
  try {
    writeMd(fx.root, 'topics/a.md', '---\ntitle: A\n---\nbody A\n');
    writeMd(fx.root, 'topics/b.md', '---\ntitle: B\n---\nbody B\n');
    git(fx.root, 'add -A');
    git(fx.root, 'commit -m initial');
    await incrementalReindex(fx.db, fx.root); // bootstrap
    const repo = new RecordsRepository(fx.db);
    const idA = repo.getByPath('topics/a.md')?.recordId;

    git(fx.root, 'mv topics/a.md topics/renamed.md');
    git(fx.root, 'mv topics/b.md topics/b.txt');

    const summary = await incrementalReindex(fx.db, fx.root, {workingTree: true});
    t.equal(summary.renamed, 1, 'one rename');
    t.equal(repo.getByPath('topics/renamed.md')?.recordId, idA, 'record id kept across the rename');
    t.equal(repo.getByPath('topics/a.md'), null, 'old path gone');
    t.equal(repo.getByPath('topics/b.md'), null, 'renamed away from .md: record removed');
    t.equal(summary.deleted, 1, 'one deletion');
  } finally {
    teardown(fx);
  }
});

test('incrementalReindex: a file that fails to parse is recorded, and the rest of the range lands', async t => {
  const fx = setup();
  try {
    writeMd(fx.root, 'topics/a.md', '---\ntitle: A\n---\nbody A\n');
    writeMd(fx.root, 'topics/stale.md', '---\ntitle: Stale\n---\nbody stale, see [[a]]\n');
    git(fx.root, 'add -A');
    git(fx.root, 'commit -m initial');
    await incrementalReindex(fx.db, fx.root); // bootstrap
    const repo = new RecordsRepository(fx.db);
    const staleId = repo.getByPath('topics/stale.md')?.recordId as string;
    const edges = new EdgesRepository(fx.db);
    t.equal(edges.listOutbound(staleId).length, 1, 'the stale note cites a');

    writeMd(fx.root, 'topics/good.md', '---\ntitle: Good\n---\nbody good\n');
    writeMd(fx.root, 'topics/bad.md', '---\ntitle: Bad\ntype: log\ntype: log\n---\nbody bad\n');
    writeMd(fx.root, 'topics/stale.md', '---\ntitle: Stale\ntitle: Twice\n---\nbody stale\n');
    git(fx.root, 'add -A');
    git(fx.root, 'commit -m two');
    const head = git(fx.root, 'rev-parse HEAD');

    await incrementalReindex(fx.db, fx.root);
    t.ok(repo.getByPath('topics/good.md'), 'the good file in the same range is indexed');
    t.equal(getLastIndexedCommit(fx.db), head, 'the anchor moves past the range');
    t.equal(edges.listOutbound(staleId).length, 1, 'the full edge pass keeps what it cannot read');
    const failures = new ImportFailuresRepository(fx.db);
    const rows = failures.list(10);
    t.deepEqual(
      rows.map(({filePath, recordId}) => ({filePath, recordId})),
      [
        {filePath: 'topics/bad.md', recordId: null},
        {filePath: 'topics/stale.md', recordId: staleId}
      ],
      'a new file is never indexed; an indexed one is stale'
    );
    for (const row of rows) t.matchString(row.message, /^Map keys must be unique/);

    writeMd(fx.root, 'topics/bad.md', '---\ntitle: Bad\ntype: log\n---\nbody bad\n');
    rmSync(join(fx.root, 'topics/stale.md'));
    git(fx.root, 'add -A');
    git(fx.root, 'commit -m three');
    await incrementalReindex(fx.db, fx.root);
    t.ok(repo.getByPath('topics/bad.md'), 'the fixed file is indexed');
    t.equal(failures.count(), 0, 'the fix and the delete clear both rows');
  } finally {
    teardown(fx);
  }
});
