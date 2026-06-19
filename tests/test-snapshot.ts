import test from 'tape-six';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGunzip} from 'node:zlib';
import {createReadStream, createWriteStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {snapshotDb} from '../src/server/snapshot.ts';

test('snapshotDb writes a valid SQLite file (uncompressed)', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'snapshot-test-'));
  try {
    const dbPath = join(tmp, 'live.sqlite');
    const db = openDatabase({path: dbPath});
    runMigrations(db);
    db.exec(`INSERT INTO meta (key, value) VALUES ('test', 'snapshot-marker')`);

    const snapPath = join(tmp, 'snap', 'vault.sqlite');
    const result = await snapshotDb(db, snapPath);
    t.equal(result.path, snapPath);
    t.ok(result.bytes > 0, 'has bytes');
    t.ok(existsSync(snapPath), 'file exists on disk');

    // Open the snapshot and confirm it's a real SQLite file with our marker.
    const snap = openDatabase({path: snapPath});
    const row = snap.prepare(`SELECT value FROM meta WHERE key = 'test'`).get() as {value: string};
    t.equal(row?.value, 'snapshot-marker', 'snapshot contains live data');
    snap.close();
    db.close();
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('snapshotDb gzips when output path ends with .gz', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'snapshot-gz-test-'));
  try {
    const dbPath = join(tmp, 'live.sqlite');
    const db = openDatabase({path: dbPath});
    runMigrations(db);
    db.exec(`INSERT INTO meta (key, value) VALUES ('compress', 'works')`);

    const snapPath = join(tmp, 'snap', 'vault.sqlite.gz');
    const result = await snapshotDb(db, snapPath);
    t.ok(result.bytes > 0);
    t.ok(existsSync(snapPath), 'gzip file exists');
    t.ok(!existsSync(snapPath.slice(0, -3) + '.tmp'), 'tmp uncompressed file cleaned up');

    // Decompress and verify the underlying SQLite is intact.
    const decompressed = join(tmp, 'verify.sqlite');
    await pipeline(createReadStream(snapPath), createGunzip(), createWriteStream(decompressed));
    const snap = openDatabase({path: decompressed});
    const row = snap.prepare(`SELECT value FROM meta WHERE key = 'compress'`).get() as {
      value: string;
    };
    t.equal(row?.value, 'works', 'gunzip → valid SQLite with live data');
    snap.close();
    db.close();
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('snapshotDb is idempotent — repeated calls overwrite', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'snapshot-idem-test-'));
  try {
    const db = openDatabase({path: join(tmp, 'live.sqlite')});
    runMigrations(db);

    const snapPath = join(tmp, 'snap.sqlite.gz');
    const a = await snapshotDb(db, snapPath);
    const b = await snapshotDb(db, snapPath);
    t.ok(a.bytes > 0);
    t.ok(b.bytes > 0);
    t.equal(b.path, snapPath, 'second call overwrites');
    db.close();
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

test('snapshotDb creates the parent directory if missing', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'snapshot-mkdir-test-'));
  try {
    const db = openDatabase({path: join(tmp, 'live.sqlite')});
    runMigrations(db);

    const snapPath = join(tmp, 'a', 'b', 'c', 'snap.sqlite');
    const result = await snapshotDb(db, snapPath);
    t.ok(existsSync(snapPath));
    t.ok(result.bytes > 0);
    db.close();
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});

// Read a file's first 16 bytes — SQLite header magic is "SQLite format 3\0".
const sqliteMagic = (path: string): string => readFileSync(path).subarray(0, 16).toString('latin1');

test('snapshotDb output passes the SQLite header check', async t => {
  const tmp = mkdtempSync(join(tmpdir(), 'snapshot-magic-test-'));
  try {
    const db = openDatabase({path: join(tmp, 'live.sqlite')});
    runMigrations(db);
    const snapPath = join(tmp, 'snap.sqlite');
    await snapshotDb(db, snapPath);
    t.equal(sqliteMagic(snapPath).slice(0, 15), 'SQLite format 3', 'has SQLite magic header');
    db.close();
  } finally {
    rmSync(tmp, {recursive: true, force: true});
  }
});
