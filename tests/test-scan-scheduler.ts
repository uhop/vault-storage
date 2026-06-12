// C8.1 scan scheduler — content-generation tracking + the
// changed-since-last-pass skip rule + work-hours window + manual-wins.

import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {getContentGeneration, getMetaValue} from '../src/db/meta.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {importVault} from '../src/importer/import.ts';
import {
  recordScanPass,
  runAllScans,
  SCAN_LAST_PASS_AT_KEY,
  SCAN_LAST_PASS_GENERATION_KEY
} from '../src/maintenance/run-all.ts';
import {startScanScheduler} from '../src/maintenance/scan-scheduler.ts';
import {RecordsRepository} from '../src/records/repository.ts';
import type {VaultRecord} from '../src/records/types.ts';

const makeDb = (): DatabaseSync => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  return db;
};

const makeRecord = (id: string, filePath: string): VaultRecord => ({
  recordId: id,
  filePath,
  parentPath: null,
  sequenceKey: null,
  type: 'permanent',
  body: `body of ${id}`,
  contentHash: `hash-${id}`,
  bodyHash: `bodyhash-${id}`,
  title: id,
  created: '2026-06-01',
  updated: '2026-06-01',
  lastReferenced: null,
  decayScore: 0,
  status: 'active',
  priority: 0,
  archivedAt: null,
  agentSummary: null,
  agentDerivedFromHash: null
});

test('content generation bumps on insert / delete / move, not on reads', t => {
  const db = makeDb();
  try {
    const records = new RecordsRepository(db);
    t.equal(getContentGeneration(db), 0, 'fresh DB starts at 0');

    records.insert(makeRecord('r1', 'topics/one.md'));
    t.equal(getContentGeneration(db), 1, 'insert bumps');

    records.upsertByPath(makeRecord('r2', 'topics/two.md'));
    t.equal(getContentGeneration(db), 2, 'upsert bumps');

    records.bumpLastReferenced('r1');
    t.equal(getContentGeneration(db), 2, 'read-path bump does not count');

    records.updateFilePath('r2', 'topics/two-moved.md');
    t.equal(getContentGeneration(db), 3, 'move bumps');

    records.updateFilePath('no-such-id', 'topics/nowhere.md');
    t.equal(getContentGeneration(db), 3, 'no-op move does not bump');

    records.delete('r1');
    t.equal(getContentGeneration(db), 4, 'delete bumps');

    records.delete('r1');
    t.equal(getContentGeneration(db), 4, 'no-op delete does not bump');
  } finally {
    db.close();
  }
});

test('unchanged re-import does not bump the generation', t => {
  const root = mkdtempSync(join(tmpdir(), 'scan-sched-test-'));
  const db = makeDb();
  try {
    mkdirSync(join(root, 'topics'), {recursive: true});
    writeFileSync(join(root, 'topics/a.md'), '---\ntitle: A\n---\nbody\n');
    importVault(db, root);
    const after = getContentGeneration(db);
    t.ok(after > 0, 'initial import bumped');

    importVault(db, root);
    t.equal(getContentGeneration(db), after, 'unchanged re-import is generation-neutral');
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('scheduler: runs on first tick, skips on quiet, re-arms on change', async t => {
  const db = makeDb();
  let clock = new Date('2026-06-11T12:00:00Z');
  let runs = 0;
  const handle = startScanScheduler({
    db,
    intervalMs: 3_600_000,
    maxQuietMs: 7 * 86_400_000,
    now: () => clock,
    runScans: d => {
      ++runs;
      recordScanPass(d, getContentGeneration(d), clock.toISOString());
    },
    log: () => {},
    onError: () => {}
  });
  try {
    t.equal(await handle.tickNow(), 'ran', 'no marker yet → first tick runs');
    t.equal(runs, 1, 'one pass');

    t.equal(await handle.tickNow(), 'skipped', 'nothing changed → skip');
    t.equal(runs, 1, 'still one pass');

    new RecordsRepository(db).insert(makeRecord('r1', 'topics/one.md'));
    t.equal(await handle.tickNow(), 'ran', 'content change re-arms');
    t.equal(runs, 2, 'two passes');

    t.equal(await handle.tickNow(), 'skipped', 'quiet again');

    clock = new Date(clock.getTime() + 8 * 86_400_000);
    t.equal(await handle.tickNow(), 'ran', 'max-quiet exceeded forces a pass');
    t.equal(runs, 3, 'three passes');
  } finally {
    handle.close();
    db.close();
  }
});

test('scheduler: work-hours window gates ticks; force bypasses it', async t => {
  const db = makeDb();
  // Local 20:00 — outside a 09:00–18:00 window regardless of host TZ math
  // because we construct the Date in local time.
  const clock = new Date(2026, 5, 11, 20, 0, 0);
  let runs = 0;
  const handle = startScanScheduler({
    db,
    intervalMs: 3_600_000,
    workHours: {start: '09:00', end: '18:00'},
    now: () => clock,
    runScans: d => {
      ++runs;
      recordScanPass(d, getContentGeneration(d), clock.toISOString());
    },
    log: () => {},
    onError: () => {}
  });
  try {
    t.equal(await handle.tickNow(), 'outside-window', 'evening tick is a no-op');
    t.equal(runs, 0, 'no pass ran');

    t.equal(await handle.tickNow(true), 'ran', 'forced tick bypasses the window');
    t.equal(runs, 1, 'forced pass ran');
  } finally {
    handle.close();
    db.close();
  }
});

test('runAllScans records the pass marker, so a manual run pushes back the scheduler', async t => {
  const db = makeDb();
  try {
    const summary = runAllScans(db);
    t.equal(typeof summary.durationMs, 'number', 'summary shape intact');
    t.equal(
      getMetaValue(db, SCAN_LAST_PASS_GENERATION_KEY),
      String(getContentGeneration(db)),
      'generation marker recorded'
    );
    t.ok(getMetaValue(db, SCAN_LAST_PASS_AT_KEY), 'timestamp marker recorded');

    let runs = 0;
    const handle = startScanScheduler({
      db,
      intervalMs: 3_600_000,
      maxQuietMs: 7 * 86_400_000,
      runScans: () => {
        ++runs;
      },
      log: () => {},
      onError: () => {}
    });
    try {
      t.equal(await handle.tickNow(), 'skipped', 'manual pass counts — scheduler skips');
      t.equal(runs, 0, 'no scheduled pass needed');
    } finally {
      handle.close();
    }
  } finally {
    db.close();
  }
});

test('scheduler: runScans errors surface via onError and do not wedge the loop', async t => {
  const db = makeDb();
  const errors: string[] = [];
  let attempt = 0;
  const handle = startScanScheduler({
    db,
    intervalMs: 3_600_000,
    now: () => new Date('2026-06-11T12:00:00Z'),
    runScans: d => {
      if (++attempt === 1) throw new Error('scan exploded');
      recordScanPass(d, getContentGeneration(d), '2026-06-11T12:00:00.000Z');
    },
    log: () => {},
    onError: err => errors.push(String(err))
  });
  try {
    t.equal(await handle.tickNow(), 'skipped', 'failed tick resolves without throwing');
    t.equal(errors.length, 1, 'error surfaced');
    t.ok(errors[0]?.includes('scan exploded'), 'error carries the cause');

    t.equal(await handle.tickNow(), 'ran', 'no marker recorded → next tick retries');
  } finally {
    handle.close();
    db.close();
  }
});
