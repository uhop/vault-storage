import test from 'tape-six';
import {DatabaseSync} from 'node:sqlite';
import {prepared, PREPARED_CAPACITY} from '../src/db/prepared.ts';

test('prepared: one statement per SQL text and database', t => {
  const a = new DatabaseSync(':memory:');
  const b = new DatabaseSync(':memory:');
  try {
    const first = prepared(a, 'SELECT 1 AS n');
    t.equal(prepared(a, 'SELECT 1 AS n'), first, 'the same text answers the same statement');
    t.notEqual(prepared(a, 'SELECT 2 AS n'), first, 'other text, another statement');
    t.notEqual(prepared(b, 'SELECT 1 AS n'), first, 'another database, another statement');
    t.deepEqual({...(first.get() as object)}, {n: 1});
  } finally {
    a.close();
    b.close();
  }
});

test('prepared: past its capacity, the least recently used statement is dropped', t => {
  const db = new DatabaseSync(':memory:');
  try {
    const kept = prepared(db, 'SELECT 0 AS n');
    const dropped = prepared(db, 'SELECT 1 AS n');
    for (let i = 2; i < PREPARED_CAPACITY; ++i) prepared(db, `SELECT ${i} AS n`);
    t.equal(prepared(db, 'SELECT 0 AS n'), kept, 'a use makes a statement recent');
    prepared(db, `SELECT ${PREPARED_CAPACITY} AS n`);
    t.equal(prepared(db, 'SELECT 0 AS n'), kept, 'the recent one stays');
    t.notEqual(prepared(db, 'SELECT 1 AS n'), dropped, 'the least recent was prepared again');
  } finally {
    db.close();
  }
});
