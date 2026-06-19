import test from 'tape-six';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {listFolder} from '../src/maintenance/folder-listing.ts';

const setup = (): DatabaseSync => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  return db;
};

const seed = (
  db: DatabaseSync,
  rows: Array<{
    path: string;
    title?: string | null;
    type?: string;
    status?: string;
    updated?: string;
  }>
): void => {
  const insert = db.prepare(
    `INSERT INTO records
       (record_id, file_path, title, type, body, content_hash, body_hash, status, created, updated)
     VALUES (?, ?, ?, ?, '', ?, '', ?, '2026-04-01', ?)`
  );
  let i = 0;
  for (const r of rows) {
    insert.run(
      `r${i++}`,
      r.path,
      r.title ?? null,
      r.type ?? 'permanent',
      `h${i}`,
      r.status ?? 'active',
      r.updated ?? '2026-04-01'
    );
  }
};

test('listFolder: empty path lists vault root subfolders', t => {
  const db = setup();
  try {
    seed(db, [
      {path: 'topics/a.md', title: 'A'},
      {path: 'topics/b.md', title: 'B'},
      {path: 'projects/x/queue.md'},
      {path: 'logs/2026/log.md'},
      {path: '_index.md', title: 'Index'}
    ]);
    const r = listFolder(db, '');
    t.deepEqual(r.subfolders, ['logs', 'projects', 'topics']);
    t.equal(r.files.length, 1);
    t.equal(r.files[0]?.path, '_index.md');
  } finally {
    db.close();
  }
});

test('listFolder: leading and trailing slashes are normalized', t => {
  const db = setup();
  try {
    seed(db, [{path: 'raw/note.md', title: 'Note'}]);
    const a = listFolder(db, 'raw');
    const b = listFolder(db, '/raw');
    const c = listFolder(db, 'raw/');
    const d = listFolder(db, '//raw//');
    t.deepEqual(a, b);
    t.deepEqual(a, c);
    t.deepEqual(a, d);
    t.equal(a.path, 'raw');
  } finally {
    db.close();
  }
});

test('listFolder: separates direct files from subfolders', t => {
  const db = setup();
  try {
    seed(db, [
      {path: 'raw/note1.md', title: 'Note 1', updated: '2026-05-01'},
      {path: 'raw/note2.md', title: 'Note 2', updated: '2026-05-02'},
      {path: 'raw/archive/old.md', title: 'Old'},
      {path: 'raw/archive/2026/older.md'}
    ]);
    const r = listFolder(db, 'raw');
    t.deepEqual(r.subfolders, ['archive']);
    t.equal(r.files.length, 2);
    // Sorted by updated DESC.
    t.equal(r.files[0]?.path, 'raw/note2.md');
    t.equal(r.files[1]?.path, 'raw/note1.md');
  } finally {
    db.close();
  }
});

test('listFolder: file metadata includes title, type, status, updated', t => {
  const db = setup();
  try {
    seed(db, [
      {
        path: 'topics/atomic.md',
        title: 'Atomic Note',
        type: 'permanent',
        status: 'active',
        updated: '2026-04-30'
      }
    ]);
    const r = listFolder(db, 'topics');
    t.equal(r.files.length, 1);
    const f = r.files[0]!;
    t.equal(f.title, 'Atomic Note');
    t.equal(f.type, 'permanent');
    t.equal(f.status, 'active');
    t.equal(f.updated, '2026-04-30');
  } finally {
    db.close();
  }
});

test('listFolder: nonexistent folder returns empty buckets', t => {
  const db = setup();
  try {
    seed(db, [{path: 'topics/a.md'}]);
    const r = listFolder(db, 'does-not-exist');
    t.deepEqual(r.subfolders, []);
    t.deepEqual(r.files, []);
    t.equal(r.path, 'does-not-exist');
  } finally {
    db.close();
  }
});

test('listFolder: LIKE wildcards in folder name are escaped', t => {
  const db = setup();
  try {
    // Create a real "weird_folder" (underscore is a LIKE wildcard).
    seed(db, [
      {path: 'weird_folder/in.md', title: 'In'},
      {path: 'weirdXfolder/wrong.md', title: 'Wrong'}
    ]);
    const r = listFolder(db, 'weird_folder');
    t.equal(r.files.length, 1);
    t.equal(r.files[0]?.path, 'weird_folder/in.md');
  } finally {
    db.close();
  }
});
