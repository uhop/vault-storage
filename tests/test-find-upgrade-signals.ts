import test from 'tape-six';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {findUpgradeSignals} from '../src/maintenance/find-upgrade-signals.ts';

const setup = (): DatabaseSync => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  return db;
};

const seedRecords = (db: DatabaseSync, n: number): void => {
  const insert = db.prepare(
    `INSERT INTO records (record_id, file_path, type, body, content_hash, created, updated)
     VALUES (?, ?, 'permanent', 'b', ?, '2026-04-01', '2026-04-01')`
  );
  for (let i = 0; i < n; i++) {
    insert.run(`r${i}`, `topics/r${i}.md`, `h${i}`);
  }
};

const seedPendingSuggestions = (db: DatabaseSync, n: number): void => {
  const insert = db.prepare(
    `INSERT INTO suggestions (id, kind, payload, status, created)
     VALUES (?, 'edge_type', '{}', 'pending', '2026-04-01')`
  );
  for (let i = 0; i < n; i++) insert.run(`s${i}`);
};

const pendingByKind = (db: DatabaseSync): Record<string, number> => {
  const rows = db
    .prepare(`SELECT kind, COUNT(*) AS n FROM suggestions WHERE status = 'pending' GROUP BY kind`)
    .all() as Array<{kind: string; n: number}>;
  return Object.fromEntries(rows.map(r => [r.kind, r.n]));
};

test('findUpgradeSignals: nothing tripped on a small DB', t => {
  const db = setup();
  try {
    seedRecords(db, 10);
    const summary = findUpgradeSignals(db);
    t.equal(summary.tripped.length, 0, 'no signals tripped');
    t.equal(summary.filed, 0);
    t.equal(summary.observed.recordCount, 10);
  } finally {
    db.close();
  }
});

test('findUpgradeSignals: record_count_high trips at the high threshold', t => {
  const db = setup();
  try {
    seedRecords(db, 100);
    const summary = findUpgradeSignals(db, {thresholds: {recordCountHigh: 50, recordCountMigrate: 200}});
    t.deepEqual(summary.tripped, ['record_count_high']);
    t.equal(summary.filed, 1);
    t.equal(pendingByKind(db)['inefficiency_detected'], 1);
  } finally {
    db.close();
  }
});

test('findUpgradeSignals: record_count_migrate trips at the migrate threshold (and supersedes high)', t => {
  const db = setup();
  try {
    seedRecords(db, 250);
    const summary = findUpgradeSignals(db, {thresholds: {recordCountHigh: 50, recordCountMigrate: 200}});
    t.deepEqual(summary.tripped, ['record_count_migrate']);
    t.equal(pendingByKind(db)['infrastructure_upgrade'], 1);
    t.notOk(pendingByKind(db)['inefficiency_detected'], 'no high while migrate trips');
  } finally {
    db.close();
  }
});

test('findUpgradeSignals: pending_backlog trips when suggestions queue is large', t => {
  const db = setup();
  try {
    seedRecords(db, 5);
    seedPendingSuggestions(db, 10);
    const summary = findUpgradeSignals(db, {thresholds: {pendingBacklog: 5}});
    // The new pending_backlog signal counts the existing pending — but
    // we're about to file one ourselves which adds to the count. Check
    // that the signal tripped against the OBSERVED value (pre-file).
    t.ok(summary.tripped.includes('review_backlog_high'));
    t.equal(summary.observed.pendingSuggestions, 10);
  } finally {
    db.close();
  }
});

test('findUpgradeSignals: idempotent on (kind, signal) pair', t => {
  const db = setup();
  try {
    seedRecords(db, 100);
    const opts = {thresholds: {recordCountHigh: 50, recordCountMigrate: 200}};
    const a = findUpgradeSignals(db, opts);
    t.equal(a.filed, 1);
    const b = findUpgradeSignals(db, opts);
    t.equal(b.filed, 0, 'no refile on second pass');
    t.deepEqual(b.tripped, ['record_count_high'], 'still reports the trip');
  } finally {
    db.close();
  }
});

test('findUpgradeSignals: payload captures current/threshold/recommendation', t => {
  const db = setup();
  try {
    seedRecords(db, 100);
    findUpgradeSignals(db, {thresholds: {recordCountHigh: 50, recordCountMigrate: 200}});
    const row = db
      .prepare(
        `SELECT payload FROM suggestions
          WHERE kind = 'inefficiency_detected'
            AND json_extract(payload, '$.signal') = 'record_count_high'`
      )
      .get() as {payload: string};
    const payload = JSON.parse(row.payload) as {
      signal: string;
      current: number;
      threshold: number;
      recommendation: string;
    };
    t.equal(payload.signal, 'record_count_high');
    t.equal(payload.current, 100);
    t.equal(payload.threshold, 50);
    t.ok(payload.recommendation.length > 0, 'recommendation present');
  } finally {
    db.close();
  }
});
