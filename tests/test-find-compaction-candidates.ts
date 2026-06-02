import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {importVault} from '../src/importer/import.ts';
import {findCompactionCandidates} from '../src/maintenance/find-compaction-candidates.ts';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'find-compact-test-'));
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  return {root, db};
};

const teardown = ({root, db}: {root: string; db: ReturnType<typeof openDatabase>}) => {
  db.close();
  rmSync(root, {recursive: true, force: true});
};

/**
 * Seed `count` pieces into `folder`, stamping both `created` and `updated`
 * with the given `YYYY-MM` prefix. The hot-window gate keys on `updated`, and
 * a missing `updated` defaults to import-time `now` (so it would read as
 * fresh) — pieces must carry an explicit past `updated` to count as cold.
 * Filenames are namespaced by `date` so two calls on the same folder (one
 * cold batch + one fresh batch) don't collide.
 */
const seedFolder = (root: string, folder: string, count: number, date = '2026-01'): void => {
  for (let i = 0; i < count; i++) {
    const stamp = `${date}-${String((i % 28) + 1).padStart(2, '0')}`;
    const name = `item-${date}-${String(i).padStart(3, '0')}.md`;
    const fm = [
      '---',
      `title: Item ${i}`,
      `created: ${stamp}`,
      `updated: ${stamp}`,
      '---',
      `Body of item ${i}.`,
      ''
    ].join('\n');
    writeMd(root, `${folder}/${name}`, fm);
  }
};

const pendingFolders = (db: DatabaseSync): string[] =>
  (
    db
      .prepare(
        `SELECT json_extract(payload, '$.folder_path') AS folder_path FROM suggestions
          WHERE kind = 'compaction_candidate' AND status = 'pending'
          ORDER BY folder_path`
      )
      .all() as Array<{folder_path: string}>
  ).map(r => r.folder_path);

test('findCompactionCandidates files suggestions for folders crossing threshold', t => {
  const fx = setup();
  try {
    // Two project folders, both cold (Jan 2026, well past the 180d project
    // window relative to the injected now). Threshold 12 → only decisions qualifies.
    seedFolder(fx.root, 'projects/p/learnings', 5);
    seedFolder(fx.root, 'projects/p/decisions', 12);
    importVault(fx.db, fx.root);

    const summary = findCompactionCandidates(fx.db, {minPieceCount: 12, now: '2026-12-01'});
    t.equal(summary.scanned, 2, 'two folders evaluated');
    t.equal(summary.qualifying, 1, 'only the large folder qualifies');
    t.equal(summary.filed, 1);
    t.deepEqual(pendingFolders(fx.db), ['projects/p/decisions']);
  } finally {
    teardown(fx);
  }
});

test('findCompactionCandidates skips topics/ and archive/ paths regardless of size', t => {
  const fx = setup();
  try {
    seedFolder(fx.root, 'topics', 50); // big but excluded (concept notes, not running-files)
    seedFolder(fx.root, 'projects/p/decisions/archive/2026', 50); // archived already
    seedFolder(fx.root, 'projects/p/decisions/sync', 50); // mechanical sync output
    importVault(fx.db, fx.root);

    // now far in the future so age can't be the reason any of these stay out —
    // exclusion is what's doing the work.
    const summary = findCompactionCandidates(fx.db, {minPieceCount: 30, now: '2027-01-01'});
    t.equal(summary.qualifying, 0, 'all three excluded by skip filters');
    t.equal(summary.filed, 0);
    t.deepEqual(pendingFolders(fx.db), []);
  } finally {
    teardown(fx);
  }
});

test('findCompactionCandidates excludes logs/ wholesale regardless of size or age', t => {
  const fx = setup();
  try {
    // logs are archive-only — they age out to logs/archive/ and are never
    // summarized. Ancient and far over the piece threshold, yet excluded.
    seedFolder(fx.root, 'logs', 50, '2020-01');
    importVault(fx.db, fx.root);

    const summary = findCompactionCandidates(fx.db, {minPieceCount: 30, now: '2027-01-01'});
    t.equal(summary.qualifying, 0, 'logs excluded even when ancient and large');
    t.equal(summary.filed, 0);
    t.deepEqual(pendingFolders(fx.db), []);
  } finally {
    teardown(fx);
  }
});

test('findCompactionCandidates hot-window gate: fresh pieces do not count toward threshold', t => {
  const fx = setup();
  try {
    // 35 project pieces (threshold 30), but only 20 are cold (Jan 2026,
    // > 180d before now); the other 15 are fresh (Nov 2026, < 180d). Only the
    // cold 20 count → below threshold → no flag.
    seedFolder(fx.root, 'projects/p/decisions', 20, '2026-01'); // cold
    seedFolder(fx.root, 'projects/p/decisions', 15, '2026-11'); // fresh
    importVault(fx.db, fx.root);

    const summary = findCompactionCandidates(fx.db, {minPieceCount: 30, now: '2026-12-01'});
    t.equal(summary.qualifying, 0, 'fresh pieces excluded → folder below threshold');
    t.deepEqual(pendingFolders(fx.db), []);
  } finally {
    teardown(fx);
  }
});

test('findCompactionCandidates hot-window gate: enough cold pieces still flags; payload counts cold only', t => {
  const fx = setup();
  try {
    // 30 cold + 15 fresh. Cold alone crosses the threshold; the payload's
    // piece_count must reflect only the 30 cold pieces, not all 45.
    seedFolder(fx.root, 'projects/p/decisions', 30, '2026-01'); // cold
    seedFolder(fx.root, 'projects/p/decisions', 15, '2026-11'); // fresh
    importVault(fx.db, fx.root);

    const summary = findCompactionCandidates(fx.db, {minPieceCount: 30, now: '2026-12-01'});
    t.equal(summary.qualifying, 1, 'cold pieces alone cross threshold');
    t.equal(summary.filed, 1);

    const row = fx.db
      .prepare(`SELECT payload FROM suggestions WHERE kind = 'compaction_candidate'`)
      .get() as {payload: string};
    const payload = JSON.parse(row.payload) as {folder_path: string; piece_count: number};
    t.equal(payload.folder_path, 'projects/p/decisions');
    t.equal(payload.piece_count, 30, 'only cold pieces counted');
  } finally {
    teardown(fx);
  }
});

test('findCompactionCandidates is idempotent on re-run', t => {
  const fx = setup();
  try {
    seedFolder(fx.root, 'projects/p/decisions', 35);
    importVault(fx.db, fx.root);

    const first = findCompactionCandidates(fx.db, {minPieceCount: 30, now: '2026-12-01'});
    t.equal(first.filed, 1);
    const second = findCompactionCandidates(fx.db, {minPieceCount: 30, now: '2026-12-01'});
    t.equal(second.filed, 0, 'no refile on second pass');
    t.equal(pendingFolders(fx.db).length, 1, 'still one pending');
  } finally {
    teardown(fx);
  }
});

test('findCompactionCandidates auto-resolves when folder drops below threshold', t => {
  const fx = setup();
  try {
    seedFolder(fx.root, 'projects/p/decisions', 35);
    importVault(fx.db, fx.root);
    findCompactionCandidates(fx.db, {minPieceCount: 30, now: '2026-12-01'});
    t.equal(pendingFolders(fx.db).length, 1, 'pending after first pass');

    // Simulate post-compact: most pieces moved to archive (excluded from the
    // scan), leaving only 25 in the original folder.
    fx.db
      .prepare(
        `DELETE FROM records WHERE file_path LIKE 'projects/p/decisions/%' AND file_path < 'projects/p/decisions/item-2026-01-010.md'`
      )
      .run();

    const summary = findCompactionCandidates(fx.db, {minPieceCount: 30, now: '2026-12-01'});
    t.equal(summary.qualifying, 0, 'folder no longer qualifies');
    t.equal(summary.autoResolved, 1, 'pending auto-promoted');
    t.equal(pendingFolders(fx.db).length, 0, 'no pending left');
    const accepted = fx.db
      .prepare(`SELECT status, resolved_by FROM suggestions WHERE kind = 'compaction_candidate'`)
      .all() as Array<{status: string; resolved_by: string}>;
    t.equal(accepted[0]?.status, 'accepted');
    t.equal(accepted[0]?.resolved_by, 'no-longer-eligible');
  } finally {
    teardown(fx);
  }
});

test('findCompactionCandidates payload captures piece count + bytes + date range', t => {
  const fx = setup();
  try {
    seedFolder(fx.root, 'projects/p/decisions', 30);
    importVault(fx.db, fx.root);
    findCompactionCandidates(fx.db, {minPieceCount: 30, now: '2026-12-01'});

    const row = fx.db
      .prepare(`SELECT payload FROM suggestions WHERE kind = 'compaction_candidate'`)
      .get() as {payload: string};
    const payload = JSON.parse(row.payload) as {
      folder_path: string;
      piece_count: number;
      total_bytes: number;
      oldest_created: string;
      newest_created: string;
    };
    t.equal(payload.folder_path, 'projects/p/decisions');
    t.equal(payload.piece_count, 30);
    t.ok(payload.total_bytes > 0, 'total_bytes populated');
    t.ok(payload.oldest_created <= payload.newest_created, 'date range coherent');
  } finally {
    teardown(fx);
  }
});

// File + reject a folder's compaction_candidate, stamping resolved_at at
// `daysAgo` before `now`.
const NOW = '2026-12-01';
const seedRejectedCompactionCandidate = (
  fx: {root: string; db: ReturnType<typeof openDatabase>},
  daysAgo: number
): void => {
  seedFolder(fx.root, 'projects/p/decisions', 35, '2026-01'); // cold + over threshold
  importVault(fx.db, fx.root);
  findCompactionCandidates(fx.db, {minPieceCount: 30, now: NOW});
  const resolvedAt = new Date(Date.parse(NOW) - daysAgo * 86_400_000).toISOString();
  fx.db
    .prepare(
      `UPDATE suggestions SET status = 'rejected', resolved_at = ?, resolved_by = 'test'
        WHERE kind = 'compaction_candidate'`
    )
    .run(resolvedAt);
};

test('compaction_candidate: reject within snooze window does not refile', t => {
  const fx = setup();
  try {
    seedRejectedCompactionCandidate(fx, 5); // 5d ago, default window 14d

    const summary = findCompactionCandidates(fx.db, {minPieceCount: 30, now: NOW});
    t.equal(summary.filed, 0, 'snoozed reject blocks refile');
    t.deepEqual(pendingFolders(fx.db), [], 'no fresh pending while snoozed');
  } finally {
    teardown(fx);
  }
});

test('compaction_candidate: reject past snooze window refiles', t => {
  const fx = setup();
  try {
    seedRejectedCompactionCandidate(fx, 20); // 20d ago, past the 14d window

    const summary = findCompactionCandidates(fx.db, {minPieceCount: 30, now: NOW});
    t.equal(summary.filed, 1, 'lapsed snooze allows refile');
    t.deepEqual(pendingFolders(fx.db), ['projects/p/decisions'], 'fresh pending filed');
  } finally {
    teardown(fx);
  }
});
