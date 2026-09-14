import test from 'tape-six';
import {execSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {getMetaValue} from '../src/db/meta.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {getLastIndexedCommit} from '../src/maintenance/incremental-reindex.ts';
import {
  IMPORTER_FINGERPRINT_KEY,
  importerFingerprint,
  startupReindex
} from '../src/maintenance/startup-reindex.ts';
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
  const root = mkdtempSync(join(tmpdir(), 'startup-reindex-test-'));
  git(root, 'init -b main');
  git(root, 'config user.name test');
  git(root, 'config user.email test@test');
  writeMd(root, 'topics/a.md', '---\ntitle: A\n---\nbody A\n');
  git(root, 'add -A');
  git(root, 'commit -m initial');
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  return {root, db};
};

const teardown = ({root, db}: {root: string; db: ReturnType<typeof openDatabase>}) => {
  db.close();
  rmSync(root, {recursive: true, force: true});
};

test('startupReindex: a fresh database gets a full import and records the fingerprint', async t => {
  const fx = setup();
  try {
    const summary = await startupReindex(fx.db, fx.root, {
      reindexMigrations: [],
      fingerprint: 'f1'
    });
    t.equal(summary.reason, 'no-anchor');
    t.equal(summary.fellBack, true, 'full import');
    t.equal(getLastIndexedCommit(fx.db), git(fx.root, 'rev-parse HEAD'), 'anchor pinned');
    t.equal(getMetaValue(fx.db, IMPORTER_FINGERPRINT_KEY), 'f1', 'fingerprint recorded');
  } finally {
    teardown(fx);
  }
});

test('startupReindex: a restart with nothing changed stays incremental', async t => {
  const fx = setup();
  try {
    await startupReindex(fx.db, fx.root, {reindexMigrations: [], fingerprint: 'f1'});
    const summary = await startupReindex(fx.db, fx.root, {
      reindexMigrations: [],
      fingerprint: 'f1'
    });
    t.equal(summary.reason, null, 'no reason for a full import');
    t.equal(summary.fellBack, false, 'incremental');
    t.equal(summary.changedFiles, 0, 'nothing to import');
  } finally {
    teardown(fx);
  }
});

test('startupReindex: a migration or a changed importer forces a full import', async t => {
  const fx = setup();
  try {
    await startupReindex(fx.db, fx.root, {reindexMigrations: [], fingerprint: 'f1'});

    const migrated = await startupReindex(fx.db, fx.root, {
      reindexMigrations: ['0099_example.sql'],
      fingerprint: 'f1'
    });
    t.equal(migrated.reason, 'migrations');
    t.equal(migrated.fellBack, true, 'full import after a migration');

    const changed = await startupReindex(fx.db, fx.root, {
      reindexMigrations: [],
      fingerprint: 'f2'
    });
    t.equal(changed.reason, 'importer-changed');
    t.equal(changed.fellBack, true, 'full import after an importer change');
    t.equal(getMetaValue(fx.db, IMPORTER_FINGERPRINT_KEY), 'f2', 'new fingerprint recorded');
  } finally {
    teardown(fx);
  }
});

test('startupReindex: a file edited while the server was down is imported', async t => {
  const fx = setup();
  try {
    await startupReindex(fx.db, fx.root, {reindexMigrations: [], fingerprint: 'f1'});
    writeMd(fx.root, 'topics/a.md', '---\ntitle: A edited\n---\nbody A, edited while down\n');
    const summary = await startupReindex(fx.db, fx.root, {
      reindexMigrations: [],
      fingerprint: 'f1'
    });
    t.equal(summary.reason, null, 'incremental');
    t.equal(new RecordsRepository(fx.db).getByPath('topics/a.md')?.title, 'A edited');
  } finally {
    teardown(fx);
  }
});

test('importerFingerprint covers the importer modules and is stable', async t => {
  const first = await importerFingerprint();
  const second = await importerFingerprint();
  t.equal(first, second, 'stable across calls');
  t.ok(/^[0-9a-f]{64}$/.test(first), 'sha-256 hex');

  const root = mkdtempSync(join(tmpdir(), 'fingerprint-test-'));
  try {
    writeFileSync(join(root, 'entry.ts'), "import {x} from './dep.ts';\n");
    writeFileSync(join(root, 'dep.ts'), 'export const x = 1;\n');
    const before = await importerFingerprint([join(root, 'entry.ts')]);
    writeFileSync(join(root, 'dep.ts'), 'export const x = 2;\n');
    const after = await importerFingerprint([join(root, 'entry.ts')]);
    t.notEqual(before, after, 'a change in an imported module changes the fingerprint');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
