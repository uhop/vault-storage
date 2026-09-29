import test from 'tape-six';
import {chunkMatrix, chunkMatrixStatus, warmChunkMatrix} from '../src/db/chunk-matrix.ts';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {embedPending} from '../src/embeddings/embed-pass.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {RecordsRepository} from '../src/records/repository.ts';
import type {VaultRecord} from '../src/records/types.ts';
import {contentHash} from '../src/util/hash.ts';
import {uuidv7} from '../src/util/uuid.ts';

const makeRecord = (path: string, body: string): VaultRecord => ({
  recordId: uuidv7(),
  filePath: path,
  parentPath: null,
  sequenceKey: null,
  type: 'permanent',
  body,
  contentHash: contentHash(body),
  bodyHash: contentHash(body),
  title: null,
  created: '2026-04-28',
  updated: '2026-04-28',
  lastReferenced: null,
  decayScore: 1,
  status: 'active',
  priority: 0,
  archivedAt: null,
  agentSummary: null,
  agentDerivedFromHash: null
});

test('warmChunkMatrix builds the matrix after a vector write, so the next reader finds it', async t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  const records = new RecordsRepository(db);
  const embedder = new FakeEmbedder();
  try {
    records.insert(makeRecord('topics/a.md', 'alpha body'));
    await embedPending(db, embedder);
    t.match(chunkMatrixStatus(db), {warm: false, rows: null, building: false}, 'nothing built yet');

    warmChunkMatrix(db);
    t.equal(chunkMatrixStatus(db).building, true, 'the build is in flight at once');
    await chunkMatrix(db);
    t.match(chunkMatrixStatus(db), {warm: true, rows: 1, building: false}, 'built and current');

    records.insert(makeRecord('topics/b.md', 'beta body'));
    await embedPending(db, embedder);
    t.equal(chunkMatrixStatus(db).warm, false, 'a vector write makes it stale');
    warmChunkMatrix(db);
    await chunkMatrix(db);
    t.match(chunkMatrixStatus(db), {warm: true, rows: 2}, 'rebuilt with the new chunk');
  } finally {
    db.close();
  }
});

test('warmChunkMatrix reports a failure instead of throwing', async t => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  db.close();
  let reported: unknown = null;
  warmChunkMatrix(db, err => {
    reported = err;
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  t.ok(reported instanceof Error, 'the error reached the reporter');
});
