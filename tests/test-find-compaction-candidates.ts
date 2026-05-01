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

const seedFolder = (root: string, folder: string, count: number): void => {
  for (let i = 0; i < count; i++) {
    const fm = ['---', `title: Item ${i}`, `created: 2026-04-${String((i % 28) + 1).padStart(2, '0')}`, '---', `Body of item ${i}.`, ''].join('\n');
    writeMd(root, `${folder}/item-${String(i).padStart(3, '0')}.md`, fm);
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
    // Three folders: small (5), medium (10), large (12). Threshold 10 → only large qualifies.
    seedFolder(fx.root, 'projects/p/learnings', 5);
    seedFolder(fx.root, 'projects/p/decisions', 10);
    seedFolder(fx.root, 'logs', 12);
    importVault(fx.db, fx.root);

    const summary = findCompactionCandidates(fx.db, {minPieceCount: 12});
    t.equal(summary.scanned, 3, 'three folders evaluated');
    t.equal(summary.qualifying, 1, 'only large folder qualifies');
    t.equal(summary.filed, 1);
    t.deepEqual(pendingFolders(fx.db), ['logs']);
  } finally {
    teardown(fx);
  }
});

test('findCompactionCandidates skips topics/ and archive/ paths regardless of size', t => {
  const fx = setup();
  try {
    seedFolder(fx.root, 'topics', 50); // big but excluded (concept notes, not running-files)
    seedFolder(fx.root, 'logs/archive/2026', 50); // archived already
    seedFolder(fx.root, 'logs/sync', 50); // mechanical sync output
    importVault(fx.db, fx.root);

    const summary = findCompactionCandidates(fx.db, {minPieceCount: 30});
    t.equal(summary.qualifying, 0, 'all three excluded by skip filters');
    t.equal(summary.filed, 0);
    t.deepEqual(pendingFolders(fx.db), []);
  } finally {
    teardown(fx);
  }
});

test('findCompactionCandidates is idempotent on re-run', t => {
  const fx = setup();
  try {
    seedFolder(fx.root, 'logs', 35);
    importVault(fx.db, fx.root);

    const first = findCompactionCandidates(fx.db, {minPieceCount: 30});
    t.equal(first.filed, 1);
    const second = findCompactionCandidates(fx.db, {minPieceCount: 30});
    t.equal(second.filed, 0, 'no refile on second pass');
    t.equal(pendingFolders(fx.db).length, 1, 'still one pending');
  } finally {
    teardown(fx);
  }
});

test('findCompactionCandidates auto-resolves when folder drops below threshold', t => {
  const fx = setup();
  try {
    seedFolder(fx.root, 'logs', 35);
    importVault(fx.db, fx.root);
    findCompactionCandidates(fx.db, {minPieceCount: 30});
    t.equal(pendingFolders(fx.db).length, 1, 'pending after first pass');

    // Simulate post-compact: most pieces moved to archive (which is excluded
    // from the scan), leaving only 5 in the original folder. Move on disk
    // by deleting from records repo + writing to archive subfolder via re-import.
    fx.db
      .prepare(
        `DELETE FROM records WHERE file_path LIKE 'logs/%' AND file_path NOT LIKE 'logs/archive/%' AND file_path < 'logs/item-030.md'`
      )
      .run();

    const summary = findCompactionCandidates(fx.db, {minPieceCount: 30});
    t.equal(summary.qualifying, 0, 'logs no longer qualifies');
    t.equal(summary.autoResolved, 1, 'pending auto-promoted');
    t.equal(pendingFolders(fx.db).length, 0, 'no pending left');
    const accepted = fx.db
      .prepare(
        `SELECT status, resolved_by FROM suggestions WHERE kind = 'compaction_candidate'`
      )
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
    seedFolder(fx.root, 'logs', 30);
    importVault(fx.db, fx.root);
    findCompactionCandidates(fx.db, {minPieceCount: 30});

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
    t.equal(payload.folder_path, 'logs');
    t.equal(payload.piece_count, 30);
    t.ok(payload.total_bytes > 0, 'total_bytes populated');
    t.ok(payload.oldest_created <= payload.newest_created, 'date range coherent');
  } finally {
    teardown(fx);
  }
});
