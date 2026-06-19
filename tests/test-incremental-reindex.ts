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
