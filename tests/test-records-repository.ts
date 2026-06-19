import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {EdgesRepository} from '../src/records/edges.ts';
import {RecordsRepository} from '../src/records/repository.ts';
import type {Edge, VaultRecord} from '../src/records/types.ts';
import {uuidv7} from '../src/util/uuid.ts';
import {contentHash} from '../src/util/hash.ts';

const makeRecord = (overrides: Partial<VaultRecord> = {}): VaultRecord => {
  const id = uuidv7();
  const now = '2026-04-28T12:00:00Z';
  const body = overrides.body ?? 'sample body';
  return {
    recordId: id,
    filePath: `topics/${id}.md`,
    parentPath: null,
    sequenceKey: null,
    type: 'permanent',
    body,
    contentHash: contentHash(body),
    bodyHash: contentHash(body),
    title: null,
    created: now,
    updated: now,
    lastReferenced: null,
    decayScore: 1,
    status: 'active',
    priority: 0,
    archivedAt: null,
    agentSummary: null,
    agentDerivedFromHash: null,
    ...overrides
  };
};

const setup = () => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  return {db, records: new RecordsRepository(db), edges: new EdgesRepository(db)};
};

test('insert + getById round-trips a record', t => {
  const {db, records} = setup();
  const r = makeRecord({type: 'design', priority: 3});
  records.insert(r);
  const got = records.getById(r.recordId);
  t.ok(got !== null, 'record fetched');
  // modified_at is DB-stamped at write (schema 0012), not caller-supplied,
  // so it won't be on the input record — assert it landed, then fold the
  // generated value into the expected before the full-field comparison.
  t.ok(
    got?.modifiedAt != null && !Number.isNaN(Date.parse(got.modifiedAt)),
    'modified_at stamped at insert'
  );
  r.modifiedAt = got?.modifiedAt;
  t.deepEqual(got, r, 'round-trip preserves all fields');
  db.close();
});

test('getByPath finds by file_path; null on miss', t => {
  const {db, records} = setup();
  const r = makeRecord({filePath: 'projects/demo/queue.md', type: 'queue-item'});
  records.insert(r);
  t.equal(records.getByPath('projects/demo/queue.md')?.recordId, r.recordId, 'found by path');
  t.equal(records.getByPath('does/not/exist.md'), null, 'null on miss');
  db.close();
});

test('upsertByPath updates on conflict, inserts otherwise', t => {
  const {db, records} = setup();
  const r1 = makeRecord({filePath: 'a.md', body: 'first'});
  records.upsertByPath(r1);

  const r2: VaultRecord = {
    ...r1,
    recordId: uuidv7(),
    body: 'second',
    contentHash: contentHash('second'),
    updated: '2026-04-29T00:00:00Z'
  };
  records.upsertByPath(r2);

  const got = records.getByPath('a.md');
  t.ok(got, 'record exists');
  t.equal(got?.recordId, r1.recordId, 'recordId preserved across upsert (ON CONFLICT keeps it)');
  t.equal(got?.body, 'second', 'body updated');
  t.equal(got?.updated, '2026-04-29T00:00:00Z', 'updated bumped');
  t.equal(records.count(), 1, 'still one row');
  db.close();
});

test('listByParent returns pieces ordered by sequence_key', t => {
  const {db, records} = setup();
  const parent = 'projects/demo/queue';
  records.insert(makeRecord({filePath: `${parent}/02.md`, parentPath: parent, sequenceKey: 2}));
  records.insert(makeRecord({filePath: `${parent}/00.md`, parentPath: parent, sequenceKey: 0}));
  records.insert(makeRecord({filePath: `${parent}/01.md`, parentPath: parent, sequenceKey: 1}));
  const list = records.listByParent(parent);
  t.deepEqual(
    list.map(r => r.sequenceKey),
    [0, 1, 2],
    'ordered by sequence_key'
  );
  db.close();
});

test('delete removes the record and cascades edges', t => {
  const {db, records, edges} = setup();
  const a = makeRecord({filePath: 'a.md'});
  const b = makeRecord({filePath: 'b.md'});
  records.insert(a);
  records.insert(b);

  const edge: Edge = {
    fromId: a.recordId,
    toId: b.recordId,
    type: 'cites',
    weight: 1,
    note: null,
    created: '2026-04-28T00:00:00Z'
  };
  edges.upsert(edge);

  t.equal(edges.listOutbound(a.recordId).length, 1, 'edge present');
  t.ok(records.delete(a.recordId), 'delete returns true');
  t.equal(records.getById(a.recordId), null, 'record gone');
  t.equal(edges.listOutbound(a.recordId).length, 0, 'edge cascaded');
  db.close();
});

test('edges upsert is idempotent on PK; updates weight/note on re-insert', t => {
  const {db, records, edges} = setup();
  const a = makeRecord({filePath: 'a.md'});
  const b = makeRecord({filePath: 'b.md'});
  records.insert(a);
  records.insert(b);

  const base: Edge = {
    fromId: a.recordId,
    toId: b.recordId,
    type: 'supersedes',
    weight: 1,
    note: null,
    created: '2026-04-28T00:00:00Z'
  };
  edges.upsert(base);
  edges.upsert({...base, weight: 0.5, note: 'partial'});

  const out = edges.listOutbound(a.recordId);
  t.equal(out.length, 1, 'no duplicate row');
  t.equal(out[0]?.weight, 0.5, 'weight updated');
  t.equal(out[0]?.note, 'partial', 'note updated');

  edges.upsert({...base, type: 'cites'});
  t.equal(edges.listOutbound(a.recordId).length, 2, 'different type creates a new edge');
  db.close();
});

test('listInbound and listByType filter as expected', t => {
  const {db, records, edges} = setup();
  const a = makeRecord({filePath: 'a.md'});
  const b = makeRecord({filePath: 'b.md'});
  const c = makeRecord({filePath: 'c.md'});
  records.insert(a);
  records.insert(b);
  records.insert(c);

  edges.upsert({
    fromId: a.recordId,
    toId: c.recordId,
    type: 'cites',
    weight: 1,
    note: null,
    created: '2026-04-28T00:00:00Z'
  });
  edges.upsert({
    fromId: b.recordId,
    toId: c.recordId,
    type: 'supersedes',
    weight: 1,
    note: null,
    created: '2026-04-28T00:00:00Z'
  });

  t.equal(edges.listInbound(c.recordId).length, 2, 'two inbound to c');
  t.equal(edges.listByType('cites').length, 1, 'one cites edge');
  t.equal(edges.listByType('rejected-because').length, 0, 'unused type returns empty');
  db.close();
});

test('record CHECK rejects an invalid type at insert', t => {
  const {db, records} = setup();
  const bad = {...makeRecord(), type: 'not-a-type'} as unknown as VaultRecord;
  t.throws(() => records.insert(bad), 'invalid type rejected');
  db.close();
});
