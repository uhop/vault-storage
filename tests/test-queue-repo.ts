import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {parseQueueFile} from '../src/queue/parse.ts';
import {QueueItemsRepository} from '../src/queue/repo.ts';

const FM = ['---', 'title: demo — Queue', 'type: project', '---', ''].join('\n');

const setup = () => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  return {db, repo: new QueueItemsRepository(db)};
};

test('migration 0008 applies and queue_items is empty', t => {
  const {db, repo} = setup();
  t.equal(repo.count(), 0, 'no rows after fresh migration');
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
    value: string;
  };
  t.equal(row.value, '14', 'schema_version bumped to 14');
  db.close();
});

test('applyParsed — initial insert', t => {
  const {db, repo} = setup();
  const src =
    FM +
    [
      '## Backlog',
      '',
      '- **First.** body A',
      '- **Second.** body B',
      '',
      '## Watching',
      '',
      '- **Upstream.** waiting'
    ].join('\n');
  const parsed = parseQueueFile('demo', 'projects/demo/queue.md', src);
  const result = repo.applyParsed('demo', 'projects/demo/queue.md', parsed, '2026-05-13T12:00:00Z');
  t.deepEqual(result, {inserted: 3, updated: 0, refreshed: 0, deleted: 0});
  t.equal(repo.count(), 3);

  const open = repo.listOpenByProject('demo');
  t.deepEqual(
    open.map(r => [r.section, r.title]),
    [
      ['backlog', 'First.'],
      ['backlog', 'Second.'],
      ['watching', 'Upstream.']
    ]
  );
  for (const r of open) {
    t.equal(r.created_at, '2026-05-13T12:00:00Z', 'created_at set from now');
    t.equal(r.updated_at, '2026-05-13T12:00:00Z', 'updated_at set from now');
  }
  db.close();
});

test('applyParsed — body change → updated, body identical but position shift → refreshed', t => {
  const {db, repo} = setup();
  const v1 = FM + ['## Backlog', '', '- **Same.** original body', '- **Other.** kept'].join('\n');
  repo.applyParsed(
    'demo',
    'projects/demo/queue.md',
    parseQueueFile('demo', 'projects/demo/queue.md', v1),
    '2026-05-13T12:00:00Z'
  );

  // v2 swaps order (position change for "Other") and rewrites "Same"'s body.
  const v2 = FM + ['## Backlog', '', '- **Other.** kept', '- **Same.** edited body'].join('\n');
  const result = repo.applyParsed(
    'demo',
    'projects/demo/queue.md',
    parseQueueFile('demo', 'projects/demo/queue.md', v2),
    '2026-05-14T00:00:00Z'
  );
  t.deepEqual(result, {inserted: 0, updated: 1, refreshed: 1, deleted: 0});

  const rows = repo.listOpenByProject('demo');
  const same = rows.find(r => r.title === 'Same.');
  const other = rows.find(r => r.title === 'Other.');
  t.equal(same?.body, 'edited body');
  t.equal(same?.updated_at, '2026-05-14T00:00:00Z', 'updated_at bumped for body change');
  t.equal(same?.created_at, '2026-05-13T12:00:00Z', 'created_at preserved');
  t.equal(other?.body, 'kept');
  t.equal(
    other?.updated_at,
    '2026-05-13T12:00:00Z',
    'updated_at NOT bumped for placement-only refresh'
  );
  t.equal(other?.position, 1, 'placement updated');
  db.close();
});

test('applyParsed — section move is DELETE + INSERT', t => {
  const {db, repo} = setup();
  const v1 = FM + ['## Backlog', '', '- **Mover.** in backlog'].join('\n');
  repo.applyParsed(
    'demo',
    'projects/demo/queue.md',
    parseQueueFile('demo', 'projects/demo/queue.md', v1),
    '2026-05-13T12:00:00Z'
  );
  const before = repo.listOpenByProject('demo')[0];
  t.equal(before?.section, 'backlog');

  const v2 = FM + ['## Active', '', '- **Mover.** in backlog'].join('\n');
  const result = repo.applyParsed(
    'demo',
    'projects/demo/queue.md',
    parseQueueFile('demo', 'projects/demo/queue.md', v2),
    '2026-05-14T00:00:00Z'
  );
  t.deepEqual(result, {inserted: 1, updated: 0, refreshed: 0, deleted: 1});

  const after = repo.listOpenByProject('demo');
  t.equal(after.length, 1, 'still one item');
  t.equal(after[0]?.section, 'active', 'now in active');
  t.notEqual(after[0]?.id, before?.id, 'fresh id (identity reset on section move)');
  db.close();
});

test('applyParsed — items removed from markdown are DELETEd', t => {
  const {db, repo} = setup();
  const v1 = FM + ['## Backlog', '', '- **A.** a', '- **B.** b', '- **C.** c'].join('\n');
  repo.applyParsed(
    'demo',
    'projects/demo/queue.md',
    parseQueueFile('demo', 'projects/demo/queue.md', v1)
  );
  t.equal(repo.count(), 3);

  const v2 = FM + ['## Backlog', '', '- **A.** a', '- **C.** c'].join('\n');
  const result = repo.applyParsed(
    'demo',
    'projects/demo/queue.md',
    parseQueueFile('demo', 'projects/demo/queue.md', v2)
  );
  t.deepEqual(
    result,
    {inserted: 0, updated: 0, refreshed: 1, deleted: 1},
    'B deleted; C refreshes position 3→2'
  );
  t.equal(repo.count(), 2);
  db.close();
});

test('applyParsed — title edit is DELETE + INSERT (identity is title_norm)', t => {
  const {db, repo} = setup();
  const v1 = FM + ['## Backlog', '', '- **Switch from nan to N-API.** body'].join('\n');
  repo.applyParsed(
    'demo',
    'projects/demo/queue.md',
    parseQueueFile('demo', 'projects/demo/queue.md', v1)
  );
  const v2 = FM + ['## Backlog', '', '- **Migrate to N-API.** body'].join('\n');
  const result = repo.applyParsed(
    'demo',
    'projects/demo/queue.md',
    parseQueueFile('demo', 'projects/demo/queue.md', v2)
  );
  t.deepEqual(result, {inserted: 1, updated: 0, refreshed: 0, deleted: 1});
  db.close();
});

test('applyParsed — rejects items from a different slice', t => {
  const {db, repo} = setup();
  const wrongSlice = parseQueueFile(
    'other-project',
    'projects/other/queue.md',
    FM + ['## Backlog', '', '- **X.** y'].join('\n')
  );
  t.throws(
    () => repo.applyParsed('demo', 'projects/demo/queue.md', wrongSlice),
    /applyParsed.*slice/,
    'mixing slices throws'
  );
  db.close();
});

test('deleteSlice removes everything under (project, source_file)', t => {
  const {db, repo} = setup();
  const src = FM + ['## Backlog', '', '- **A.** a', '- **B.** b'].join('\n');
  repo.applyParsed(
    'demo',
    'projects/demo/queue.md',
    parseQueueFile('demo', 'projects/demo/queue.md', src)
  );
  t.equal(repo.count(), 2);
  t.equal(repo.deleteSlice('demo', 'projects/demo/queue.md'), 2);
  t.equal(repo.count(), 0);
  db.close();
});

test('listTopOpen — fleet-wide priority ordering', t => {
  const {db, repo} = setup();
  const srcA =
    FM +
    [
      '## Backlog',
      '',
      '### Priority +2',
      '',
      '- **A-top.** a',
      '### Priority 0',
      '',
      '- **A-normal.** a'
    ].join('\n');
  const srcB =
    FM +
    [
      '## Backlog',
      '',
      '### Priority +1',
      '',
      '- **B-boosted.** b',
      '### Priority -1',
      '',
      '- **B-demoted.** b'
    ].join('\n');
  repo.applyParsed(
    'alpha',
    'projects/alpha/queue.md',
    parseQueueFile('alpha', 'projects/alpha/queue.md', srcA)
  );
  repo.applyParsed(
    'bravo',
    'projects/bravo/queue.md',
    parseQueueFile('bravo', 'projects/bravo/queue.md', srcB)
  );

  const top = repo.listTopOpen(10);
  t.deepEqual(
    top.map(r => [r.priority, r.project, r.title]),
    [
      [2, 'alpha', 'A-top.'],
      [1, 'bravo', 'B-boosted.'],
      [0, 'alpha', 'A-normal.'],
      [-1, 'bravo', 'B-demoted.']
    ]
  );
  db.close();
});

test('listBySection / listByPriority — fleet-wide section + priority filters', t => {
  const {db, repo} = setup();
  repo.applyParsed(
    'alpha',
    'projects/alpha/queue.md',
    parseQueueFile(
      'alpha',
      'projects/alpha/queue.md',
      FM +
        [
          '## Active',
          '',
          '- **A-active.** a',
          '## Backlog',
          '',
          '### Priority +1',
          '',
          '- **A-boost.** a'
        ].join('\n')
    )
  );
  repo.applyParsed(
    'bravo',
    'projects/bravo/queue.md',
    parseQueueFile(
      'bravo',
      'projects/bravo/queue.md',
      FM +
        [
          '## Active',
          '',
          '- **B-active.** b',
          '## Backlog',
          '',
          '### Priority +1',
          '',
          '- **B-boost.** b'
        ].join('\n')
    )
  );

  const active = repo.listBySection('active');
  t.deepEqual(
    active.map(r => r.title),
    ['A-active.', 'B-active.']
  );

  const p1 = repo.listByPriority(1);
  t.deepEqual(
    p1.map(r => r.title),
    ['A-boost.', 'B-boost.']
  );
  db.close();
});

test('archive slice — listArchiveByProject orders by closed_at desc, NULLS last', t => {
  const {db, repo} = setup();
  const src =
    FM +
    [
      '## 2026-05-13',
      '',
      '- **Recent.** shipped',
      '## 2026-04-01',
      '',
      '- **Older.** shipped',
      '## Undated',
      '',
      '- **Undated item.** closed at some point'
    ].join('\n');
  repo.applyParsed(
    'demo',
    'projects/demo/queue-archive.md',
    parseQueueFile('demo', 'projects/demo/queue-archive.md', src)
  );

  const archive = repo.listArchiveByProject('demo');
  t.deepEqual(
    archive.map(r => [r.closed_at, r.title]),
    [
      ['2026-05-13', 'Recent.'],
      ['2026-04-01', 'Older.'],
      [null, 'Undated item.']
    ]
  );
  db.close();
});

test('two slices share the same project (queue.md + queue-archive.md)', t => {
  const {db, repo} = setup();
  repo.applyParsed(
    'demo',
    'projects/demo/queue.md',
    parseQueueFile(
      'demo',
      'projects/demo/queue.md',
      FM + ['## Backlog', '', '- **Open.** ...'].join('\n')
    )
  );
  repo.applyParsed(
    'demo',
    'projects/demo/queue-archive.md',
    parseQueueFile(
      'demo',
      'projects/demo/queue-archive.md',
      FM + ['## 2026-05-01', '', '- **Closed.** shipped'].join('\n')
    )
  );
  t.equal(repo.count(), 2);
  t.equal(repo.listOpenByProject('demo').length, 1);
  t.equal(repo.listArchiveByProject('demo').length, 1);

  // Deleting the queue.md slice leaves the archive slice intact.
  t.equal(repo.deleteSlice('demo', 'projects/demo/queue.md'), 1);
  t.equal(repo.listArchiveByProject('demo').length, 1, 'archive slice untouched');
  db.close();
});
