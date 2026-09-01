import test from 'tape-six';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {importVault} from '../src/importer/import.ts';
import {expireLogs} from '../src/maintenance/expire-logs.ts';
import {findRetentionCandidates} from '../src/maintenance/find-retention-candidates.ts';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'expire-logs-test-'));
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  return {root, db};
};

const teardown = ({root, db}: {root: string; db: ReturnType<typeof openDatabase>}) => {
  db.close();
  rmSync(root, {recursive: true, force: true});
};

const ageDays = (d: Date, days: number): string => {
  const past = new Date(d.getTime() - days * 86_400_000);
  return past.toISOString().slice(0, 10);
};

const paths = (db: DatabaseSync): string[] =>
  (
    db.prepare(`SELECT file_path FROM records ORDER BY file_path`).all() as Array<{
      file_path: string;
    }>
  ).map(r => r.file_path);

const NOW = new Date('2026-05-01T00:00:00Z');

test('expireLogs: deletes logs past the window, keeps fresh ones', t => {
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'logs/old.md',
      `---\ntitle: Old\nupdated: ${ageDays(NOW, 100)}\ncreated: ${ageDays(NOW, 100)}\n---\nbody\n`
    );
    writeMd(
      fx.root,
      'logs/recent.md',
      `---\ntitle: Recent\nupdated: ${ageDays(NOW, 30)}\ncreated: ${ageDays(NOW, 30)}\n---\nbody\n`
    );
    importVault(fx.db, fx.root);

    const summary = expireLogs(fx.db, fx.root, {now: NOW.toISOString()});
    t.equal(summary.scanned, 2, 'both logs evaluated');
    t.equal(summary.qualifying, 1);
    t.equal(summary.deleted, 1);
    t.equal(summary.logs[0]?.file_path, 'logs/old.md');
    t.equal(summary.logs[0]?.age_days, 100);
    t.deepEqual(paths(fx.db), ['logs/recent.md'], 'row removed from the DB');
    t.notOk(existsSync(join(fx.root, 'logs/old.md')), 'file removed from disk');
    t.ok(existsSync(join(fx.root, 'logs/recent.md')), 'fresh log untouched');
  } finally {
    teardown(fx);
  }
});

test('expireLogs: only type log — a meta summary of the same age survives', t => {
  const fx = setup();
  try {
    // The `_summary-*` distillates the hygiene policy preserves are
    // `type: meta`, so the type predicate excludes them without any
    // name matching.
    writeMd(
      fx.root,
      'logs/_summary-2026-01-01-to-2026-01-31.md',
      `---\ntitle: Summary\ntype: meta\nupdated: ${ageDays(NOW, 300)}\ncreated: ${ageDays(NOW, 300)}\n---\nbody\n`
    );
    writeMd(
      fx.root,
      'topics/old-topic.md',
      `---\ntitle: Topic\nupdated: ${ageDays(NOW, 900)}\ncreated: ${ageDays(NOW, 900)}\n---\nbody\n`
    );
    writeMd(
      fx.root,
      'logs/old.md',
      `---\ntitle: Old\nupdated: ${ageDays(NOW, 100)}\ncreated: ${ageDays(NOW, 100)}\n---\nbody\n`
    );
    importVault(fx.db, fx.root);

    const summary = expireLogs(fx.db, fx.root, {now: NOW.toISOString()});
    t.equal(summary.scanned, 1, 'only the log is even evaluated');
    t.equal(summary.deleted, 1);
    t.deepEqual(paths(fx.db), ['logs/_summary-2026-01-01-to-2026-01-31.md', 'topics/old-topic.md']);
  } finally {
    teardown(fx);
  }
});

test('expireLogs: ages on created, so an updated bump does not extend life', t => {
  const fx = setup();
  try {
    // An `agent:` enrichment refresh re-stamps `updated`. Keying on it
    // would keep a two-year-old log alive forever.
    writeMd(
      fx.root,
      'logs/touched.md',
      `---\ntitle: Touched\ncreated: ${ageDays(NOW, 200)}\nupdated: ${ageDays(NOW, 1)}\n---\nbody\n`
    );
    importVault(fx.db, fx.root);

    const summary = expireLogs(fx.db, fx.root, {now: NOW.toISOString()});
    t.equal(summary.qualifying, 1, 'created decides, not updated');
    t.equal(summary.logs[0]?.age_days, 200);
    t.deepEqual(paths(fx.db), []);
  } finally {
    teardown(fx);
  }
});

test('expireLogs: dryRun reports without touching disk or DB', t => {
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'logs/old.md',
      `---\ntitle: Old\nupdated: ${ageDays(NOW, 100)}\ncreated: ${ageDays(NOW, 100)}\n---\nbody\n`
    );
    importVault(fx.db, fx.root);

    const summary = expireLogs(fx.db, fx.root, {now: NOW.toISOString(), dryRun: true});
    t.ok(summary.dryRun);
    t.equal(summary.qualifying, 1);
    t.equal(summary.deleted, 0, 'nothing deleted');
    t.equal(summary.logs.length, 1, 'still reports what would go');
    t.deepEqual(paths(fx.db), ['logs/old.md']);
    t.ok(existsSync(join(fx.root, 'logs/old.md')));
  } finally {
    teardown(fx);
  }
});

test('expireLogs: archived and superseded logs are skipped', t => {
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'logs/archived.md',
      `---\ntitle: A\nstatus: archived\nupdated: ${ageDays(NOW, 300)}\ncreated: ${ageDays(NOW, 300)}\n---\nbody\n`
    );
    writeMd(
      fx.root,
      'logs/superseded.md',
      `---\ntitle: S\nstatus: superseded\nupdated: ${ageDays(NOW, 300)}\ncreated: ${ageDays(NOW, 300)}\n---\nbody\n`
    );
    importVault(fx.db, fx.root);

    const summary = expireLogs(fx.db, fx.root, {now: NOW.toISOString()});
    t.equal(summary.scanned, 0, 'neither is in the active set');
    t.equal(summary.deleted, 0);
    t.equal(paths(fx.db).length, 2);
  } finally {
    teardown(fx);
  }
});

test('expireLogs: custom days threshold', t => {
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'logs/mid.md',
      `---\ntitle: Mid\nupdated: ${ageDays(NOW, 45)}\ncreated: ${ageDays(NOW, 45)}\n---\nbody\n`
    );
    importVault(fx.db, fx.root);

    t.equal(expireLogs(fx.db, fx.root, {now: NOW.toISOString(), dryRun: true}).qualifying, 0);
    const summary = expireLogs(fx.db, fx.root, {now: NOW.toISOString(), days: 30});
    t.equal(summary.days, 30);
    t.equal(summary.deleted, 1);
  } finally {
    teardown(fx);
  }
});

test('expireLogs: limit caps a pass, oldest first', t => {
  const fx = setup();
  try {
    for (const [name, age] of [
      ['a', 100],
      ['b', 300],
      ['c', 200]
    ] as Array<[string, number]>) {
      writeMd(
        fx.root,
        `logs/${name}.md`,
        `---\ntitle: ${name}\nupdated: ${ageDays(NOW, age)}\ncreated: ${ageDays(NOW, age)}\n---\nbody\n`
      );
    }
    importVault(fx.db, fx.root);

    const summary = expireLogs(fx.db, fx.root, {now: NOW.toISOString(), limit: 2});
    t.equal(summary.qualifying, 3, 'qualifying counts the whole set');
    t.equal(summary.deleted, 2, 'limit caps the deletions');
    t.deepEqual(
      summary.logs.map(l => l.file_path),
      ['logs/b.md', 'logs/c.md'],
      'oldest go first'
    );
    t.deepEqual(paths(fx.db), ['logs/a.md']);
  } finally {
    teardown(fx);
  }
});

test('expireLogs: a missing file still clears its row', t => {
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'logs/old.md',
      `---\ntitle: Old\nupdated: ${ageDays(NOW, 100)}\ncreated: ${ageDays(NOW, 100)}\n---\nbody\n`
    );
    importVault(fx.db, fx.root);
    rmSync(join(fx.root, 'logs/old.md'));

    const summary = expireLogs(fx.db, fx.root, {now: NOW.toISOString()});
    t.equal(summary.deleted, 1);
    t.equal(summary.errors.length, 0, 'a missing file is the expected partial state');
    t.deepEqual(paths(fx.db), []);
  } finally {
    teardown(fx);
  }
});

test('expireLogs: deleting a log resolves its pending archive_candidate', t => {
  const fx = setup();
  try {
    writeMd(
      fx.root,
      'logs/old.md',
      `---\ntitle: Old\nupdated: ${ageDays(NOW, 100)}\ncreated: ${ageDays(NOW, 100)}\n---\nbody\n`
    );
    importVault(fx.db, fx.root);
    findRetentionCandidates(fx.db, {now: NOW.toISOString()});

    const pending = (): number =>
      (
        fx.db
          .prepare(
            `SELECT COUNT(*) AS n FROM suggestions
              WHERE kind = 'archive_candidate' AND status = 'pending'`
          )
          .get() as {n: number}
      ).n;
    t.equal(pending(), 1, 'the scan filed one');

    expireLogs(fx.db, fx.root, {now: NOW.toISOString()});
    t.equal(pending(), 0, 'the delete trigger closed it');
  } finally {
    teardown(fx);
  }
});
