import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {importVault} from '../src/importer/import.ts';
import {findRetentionCandidates} from '../src/maintenance/find-retention-candidates.ts';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'find-retention-test-'));
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

const pendingPaths = (db: DatabaseSync): string[] =>
  (
    db
      .prepare(
        `SELECT json_extract(payload, '$.file_path') AS file_path FROM suggestions
          WHERE kind = 'archive_candidate' AND status = 'pending'
          ORDER BY file_path`
      )
      .all() as Array<{file_path: string}>
  ).map(r => r.file_path);

test('findRetentionCandidates: log > 90d files archive_candidate', t => {
  const fx = setup();
  try {
    const now = new Date('2026-05-01T00:00:00Z');
    writeMd(
      fx.root,
      'logs/old.md',
      `---\ntitle: Old\nupdated: ${ageDays(now, 100)}\ncreated: ${ageDays(now, 100)}\n---\nbody\n`
    );
    writeMd(
      fx.root,
      'logs/recent.md',
      `---\ntitle: Recent\nupdated: ${ageDays(now, 30)}\ncreated: ${ageDays(now, 30)}\n---\nbody\n`
    );
    importVault(fx.db, fx.root);

    const summary = findRetentionCandidates(fx.db, {now: now.toISOString()});
    t.equal(summary.qualifying, 1, 'only the 100-day log qualifies');
    t.equal(summary.filed, 1);
    t.deepEqual(pendingPaths(fx.db), ['logs/old.md']);
  } finally {
    teardown(fx);
  }
});

test('findRetentionCandidates: queue-item only when status=done', t => {
  const fx = setup();
  try {
    const now = new Date('2026-05-01T00:00:00Z');
    writeMd(
      fx.root,
      'projects/p/queue/active.md',
      `---\ntitle: Active\ntype: queue-item\nstatus: active\nupdated: ${ageDays(now, 200)}\ncreated: ${ageDays(now, 200)}\n---\nbody\n`
    );
    writeMd(
      fx.root,
      'projects/p/queue/done.md',
      `---\ntitle: Done\ntype: queue-item\nstatus: done\nupdated: ${ageDays(now, 100)}\ncreated: ${ageDays(now, 100)}\n---\nbody\n`
    );
    importVault(fx.db, fx.root);

    const summary = findRetentionCandidates(fx.db, {now: now.toISOString()});
    t.equal(summary.qualifying, 1, 'only the done one qualifies');
    t.deepEqual(pendingPaths(fx.db), ['projects/p/queue/done.md']);
  } finally {
    teardown(fx);
  }
});

test('findRetentionCandidates: long-lived types (permanent) never qualify', t => {
  const fx = setup();
  try {
    const now = new Date('2026-05-01T00:00:00Z');
    writeMd(
      fx.root,
      'topics/old.md',
      `---\ntitle: Topic\nupdated: ${ageDays(now, 1000)}\ncreated: ${ageDays(now, 1000)}\n---\nbody\n`
    );
    importVault(fx.db, fx.root);

    const summary = findRetentionCandidates(fx.db, {now: now.toISOString()});
    t.equal(summary.qualifying, 0, 'permanent never auto-archives');
  } finally {
    teardown(fx);
  }
});

test('findRetentionCandidates: idempotent on re-run', t => {
  const fx = setup();
  try {
    const now = new Date('2026-05-01T00:00:00Z');
    writeMd(
      fx.root,
      'logs/old.md',
      `---\ntitle: Old\nupdated: ${ageDays(now, 100)}\ncreated: ${ageDays(now, 100)}\n---\nbody\n`
    );
    importVault(fx.db, fx.root);

    const first = findRetentionCandidates(fx.db, {now: now.toISOString()});
    t.equal(first.filed, 1);
    const second = findRetentionCandidates(fx.db, {now: now.toISOString()});
    t.equal(second.filed, 0, 'no refile on second pass');
  } finally {
    teardown(fx);
  }
});

test('findRetentionCandidates: status=archived skipped (already out of active set)', t => {
  const fx = setup();
  try {
    const now = new Date('2026-05-01T00:00:00Z');
    writeMd(
      fx.root,
      'logs/already-archived.md',
      `---\ntitle: AA\nstatus: archived\nupdated: ${ageDays(now, 200)}\ncreated: ${ageDays(now, 200)}\n---\nbody\n`
    );
    importVault(fx.db, fx.root);
    const summary = findRetentionCandidates(fx.db, {now: now.toISOString()});
    t.equal(summary.qualifying, 0);
    t.equal(summary.scanned, 0, 'archived records skipped before threshold check');
  } finally {
    teardown(fx);
  }
});

test('archive_candidate auto-resolves when status flips to archived', t => {
  const fx = setup();
  try {
    const now = new Date('2026-05-01T00:00:00Z');
    writeMd(
      fx.root,
      'logs/old.md',
      `---\ntitle: Old\nupdated: ${ageDays(now, 100)}\ncreated: ${ageDays(now, 100)}\n---\nbody v1\n`
    );
    importVault(fx.db, fx.root);
    findRetentionCandidates(fx.db, {now: now.toISOString()});
    t.equal(pendingPaths(fx.db).length, 1, 'pending after scan');

    // User flips FM status to archived; reimport detects and auto-resolves.
    writeMd(
      fx.root,
      'logs/old.md',
      `---\ntitle: Old\nstatus: archived\nupdated: ${ageDays(now, 100)}\ncreated: ${ageDays(now, 100)}\n---\nbody v1\n`
    );
    importVault(fx.db, fx.root);
    t.equal(pendingPaths(fx.db).length, 0, 'pending cleared on archive flip');
    const accepted = fx.db
      .prepare(
        `SELECT status, resolved_by FROM suggestions WHERE kind = 'archive_candidate'`
      )
      .all() as Array<{status: string; resolved_by: string}>;
    t.equal(accepted[0]?.status, 'accepted');
    t.equal(accepted[0]?.resolved_by, 'archived');
  } finally {
    teardown(fx);
  }
});
