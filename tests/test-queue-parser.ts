import test from 'tape-six';
import {inferCloseReason, normalizeTitle, parseQueueFile} from '../src/queue/parse.ts';

const QUEUE_PATH = 'projects/demo/queue.md';
const ARCHIVE_PATH = 'projects/demo/queue-archive.md';

const FM = ['---', 'title: demo — Queue', 'type: project', '---', ''].join('\n');

test('normalizeTitle', async t => {
  await t.test('lowercases', t => {
    t.equal(normalizeTitle('Hello World'), 'hello world');
  });
  await t.test('collapses whitespace runs', t => {
    t.equal(normalizeTitle('foo    bar\tbaz\n  qux'), 'foo bar baz qux');
  });
  await t.test('unifies hyphen variants', t => {
    // U+2013 en-dash, U+2014 em-dash, U+2010 hyphen, U+2015 horizontal bar
    t.equal(normalizeTitle('a–b—c‐d―e'), 'a-b-c-d-e');
  });
  await t.test('trims', t => {
    t.equal(normalizeTitle('   spaced   '), 'spaced');
  });
});

test('inferCloseReason — first-match-wins', async t => {
  await t.test('shipped from explicit keyword', t => {
    t.equal(inferCloseReason('Shipped 2026-05-13 in commit abc.'), 'shipped');
  });
  await t.test('rejected', t => {
    t.equal(inferCloseReason("Won't fix — design constraint."), 'rejected');
  });
  await t.test('parked', t => {
    t.equal(inferCloseReason('Parked until upstream lands.'), 'parked');
  });
  await t.test('deferred', t => {
    t.equal(inferCloseReason('Deferred indefinitely; no consumer.'), 'deferred');
  });
  await t.test('fallback shipped via done/completed', t => {
    t.equal(inferCloseReason('All TODOs completed in last release.'), 'shipped');
  });
  await t.test('null when no rule matches', t => {
    t.equal(inferCloseReason('Just a sentence with no signal.'), null);
  });
});

test('parseQueueFile — queue.md basics', async t => {
  await t.test('empty Active section emits no items', t => {
    const src = FM + ['## Active', '', '(empty)', '', '## Backlog', '', '## Watching', ''].join('\n');
    const items = parseQueueFile('demo', QUEUE_PATH, src);
    t.equal(items.length, 0);
  });

  await t.test('flat Backlog → all items priority 0, positions 1..N', t => {
    const src =
      FM +
      [
        '## Active',
        '',
        '## Backlog',
        '',
        '- **First.** Body of first.',
        '- **Second.** Body of second.',
        '- **Third.** Body of third.',
        '',
        '## Watching',
        ''
      ].join('\n');
    const items = parseQueueFile('demo', QUEUE_PATH, src);
    t.equal(items.length, 3);
    t.deepEqual(
      items.map(it => [it.section, it.priority, it.position, it.title]),
      [
        ['backlog', 0, 1, 'First.'],
        ['backlog', 0, 2, 'Second.'],
        ['backlog', 0, 3, 'Third.']
      ]
    );
  });

  await t.test('Backlog with priority subsections positions per tier', t => {
    const src =
      FM +
      [
        '## Backlog',
        '',
        '### Priority +2',
        '',
        '- **Top urgency.** Do this first.',
        '',
        '### Priority +1',
        '',
        '- **Boosted A.** ...',
        '- **Boosted B.** ...',
        '',
        '### Priority 0',
        '',
        '- **Normal item.** ...',
        '',
        '### Priority -1',
        '',
        '- **Demoted.** Probably never.',
        ''
      ].join('\n');
    const items = parseQueueFile('demo', QUEUE_PATH, src);
    t.equal(items.length, 5);
    t.deepEqual(
      items.map(it => [it.priority, it.position, it.title]),
      [
        [2, 1, 'Top urgency.'],
        [1, 1, 'Boosted A.'],
        [1, 2, 'Boosted B.'],
        [0, 1, 'Normal item.'],
        [-1, 1, 'Demoted.']
      ]
    );
  });

  await t.test('Active and Watching ignore priority subsections', t => {
    const src =
      FM +
      [
        '## Active',
        '',
        '- **Started item.** In flight.',
        '',
        '## Watching',
        '',
        '- **Upstream PR.** Waiting on nan #1016.'
      ].join('\n');
    const items = parseQueueFile('demo', QUEUE_PATH, src);
    t.equal(items.length, 2);
    t.deepEqual(
      items.map(it => [it.section, it.priority, it.position, it.title]),
      [
        ['active', 0, 1, 'Started item.'],
        ['watching', 0, 1, 'Upstream PR.']
      ]
    );
  });

  await t.test('multi-line item with sub-bullets and prose continuation', t => {
    const src =
      FM +
      [
        '## Backlog',
        '',
        '- **Implement X.** Some intro prose.',
        '',
        '  More prose still inside the item.',
        '  - sub-bullet A',
        '  - sub-bullet B',
        '',
        '- **Second item.** Short.'
      ].join('\n');
    const items = parseQueueFile('demo', QUEUE_PATH, src);
    t.equal(items.length, 2);
    t.equal(items[0]?.title, 'Implement X.');
    t.ok(items[0]?.body.includes('More prose still inside the item.'), 'continuation prose in body');
    t.ok(items[0]?.body.includes('- sub-bullet A'), 'sub-bullets in body');
    t.equal(items[1]?.title, 'Second item.');
  });

  await t.test('fenced code inside item body does not split into a new item', t => {
    const src =
      FM +
      [
        '## Backlog',
        '',
        '- **Code-bearing item.** Example:',
        '',
        '  ```bash',
        '  - this looks like a bullet but is in code',
        '  ## this looks like a heading',
        '  ```',
        '',
        '  Trailing prose.',
        '',
        '- **After code.** Next item.'
      ].join('\n');
    const items = parseQueueFile('demo', QUEUE_PATH, src);
    t.equal(items.length, 2);
    t.equal(items[0]?.title, 'Code-bearing item.');
    t.ok(items[0]?.body.includes('- this looks like a bullet but is in code'), 'code body preserved verbatim');
    t.ok(items[0]?.body.includes('## this looks like a heading'), 'code body preserved verbatim');
    t.equal(items[1]?.title, 'After code.');
  });

  await t.test('source_line is 1-based against the original file (FM included)', t => {
    const src =
      FM +
      [
        '## Backlog',
        '',
        '- **First.** body',
        '- **Second.** body'
      ].join('\n');
    // FM is 5 lines (---, title, type, ---, blank trailing newline before first body line)
    const items = parseQueueFile('demo', QUEUE_PATH, src);
    t.equal(items.length, 2);
    const firstLineInOriginal = src.split('\n').findIndex(l => l.startsWith('- **First.**')) + 1;
    const secondLineInOriginal = src.split('\n').findIndex(l => l.startsWith('- **Second.**')) + 1;
    t.equal(items[0]?.source_line, firstLineInOriginal);
    t.equal(items[1]?.source_line, secondLineInOriginal);
  });

  await t.test('body_hash stable for same title+body, distinct otherwise', t => {
    const a = parseQueueFile('demo', QUEUE_PATH, FM + ['## Backlog', '', '- **T.** Body A.'].join('\n'));
    const b = parseQueueFile('demo', QUEUE_PATH, FM + ['## Backlog', '', '- **T.** Body A.'].join('\n'));
    const c = parseQueueFile('demo', QUEUE_PATH, FM + ['## Backlog', '', '- **T.** Body B.'].join('\n'));
    t.equal(a[0]?.body_hash, b[0]?.body_hash, 'identical content → identical hash');
    t.notEqual(a[0]?.body_hash, c[0]?.body_hash, 'different body → different hash');
  });

  await t.test('non-archive items have closed_at and close_reason null', t => {
    const src = FM + ['## Backlog', '', '- **Shipped-looking title.** This says shipped but section is backlog.'].join('\n');
    const items = parseQueueFile('demo', QUEUE_PATH, src);
    t.equal(items[0]?.closed_at, null);
    t.equal(items[0]?.close_reason, null);
  });

  await t.test('items above the first heading are dropped', t => {
    const src = FM + ['Intro paragraph.', '', '- **Orphan.** No section.', '', '## Backlog', '', '- **Real.** Body.'].join('\n');
    const items = parseQueueFile('demo', QUEUE_PATH, src);
    t.equal(items.length, 1);
    t.equal(items[0]?.title, 'Real.');
  });

  await t.test('items without bold prefix fall back to first-line title', t => {
    const src = FM + ['## Backlog', '', '- A bare item with no bold marker.'].join('\n');
    const items = parseQueueFile('demo', QUEUE_PATH, src);
    t.equal(items.length, 1);
    t.equal(items[0]?.title, 'A bare item with no bold marker.');
    t.equal(items[0]?.body, '');
  });

  await t.test('bold title may contain single asterisks (italics, glob patterns)', t => {
    const src =
      FM +
      [
        '## Backlog',
        '',
        '- **Endpoints under `/queue/*`.** Body for the glob item.',
        '- **Refresh *Web Applications: the modern API design*.** Body for the italic item.'
      ].join('\n');
    const items = parseQueueFile('demo', QUEUE_PATH, src);
    t.equal(items.length, 2);
    t.equal(items[0]?.title, 'Endpoints under `/queue/*`.');
    t.equal(items[0]?.body, 'Body for the glob item.');
    t.equal(items[1]?.title, 'Refresh *Web Applications: the modern API design*.');
    t.equal(items[1]?.body, 'Body for the italic item.');
  });
});

test('parseQueueFile — queue-archive.md', async t => {
  await t.test('date heading drives closed_at; items get section=archive', t => {
    const src =
      FM +
      [
        '## 2026-05-13',
        '',
        '- **Recent item.** Shipped in commit abc.',
        '- **Another recent.** Done in this release.',
        '',
        '## 2026-04-01',
        '',
        '- **Older item.** Parked when scope cut.'
      ].join('\n');
    const items = parseQueueFile('demo', ARCHIVE_PATH, src);
    t.equal(items.length, 3);
    t.deepEqual(
      items.map(it => [it.section, it.closed_at, it.close_reason, it.title]),
      [
        ['archive', '2026-05-13', 'shipped', 'Recent item.'],
        ['archive', '2026-05-13', 'shipped', 'Another recent.'],
        ['archive', '2026-04-01', 'parked', 'Older item.']
      ]
    );
  });

  await t.test('Pre- and Undated headings yield closed_at=null', t => {
    const src =
      FM +
      [
        '## Pre-2026-04',
        '',
        '- **Old A.** Shipped long ago.',
        '',
        '## Undated',
        '',
        '- **No date.** Resolved at some point.'
      ].join('\n');
    const items = parseQueueFile('demo', ARCHIVE_PATH, src);
    t.equal(items.length, 2);
    t.equal(items[0]?.closed_at, null);
    t.equal(items[1]?.closed_at, null);
    t.equal(items[0]?.section, 'archive');
    t.equal(items[0]?.close_reason, 'shipped');
    t.equal(items[1]?.close_reason, 'shipped');
  });

  await t.test('positions restart per date bucket', t => {
    const src =
      FM +
      [
        '## 2026-05-13',
        '',
        '- **A.** shipped',
        '- **B.** shipped',
        '',
        '## 2026-05-12',
        '',
        '- **C.** shipped',
        '- **D.** shipped'
      ].join('\n');
    const items = parseQueueFile('demo', ARCHIVE_PATH, src);
    t.deepEqual(
      items.map(it => [it.closed_at, it.position, it.title]),
      [
        ['2026-05-13', 1, 'A.'],
        ['2026-05-13', 2, 'B.'],
        ['2026-05-12', 1, 'C.'],
        ['2026-05-12', 2, 'D.']
      ]
    );
  });

  await t.test('close_reason regex inference covers each rule', t => {
    const src =
      FM +
      [
        '## 2026-05-13',
        '',
        '- **A.** Shipped in commit abc.',
        '- **B.** Rejected per design — not building.',
        '- **C.** Parked until upstream lands.',
        '- **D.** Deferred indefinitely; no consumer.',
        '- **E.** All TODOs completed.',
        '- **F.** Neutral text with no closure signal.'
      ].join('\n');
    const items = parseQueueFile('demo', ARCHIVE_PATH, src);
    t.deepEqual(
      items.map(it => it.close_reason),
      ['shipped', 'rejected', 'parked', 'deferred', 'shipped', null]
    );
  });
});

test('parseQueueFile — title_norm stable under cosmetic edits', t => {
  const a = parseQueueFile('demo', QUEUE_PATH, FM + ['## Backlog', '', '- **Switch from nan to N-API.** ...'].join('\n'));
  const b = parseQueueFile('demo', QUEUE_PATH, FM + ['## Backlog', '', '- **  Switch  from  nan  to  N–API.  ** ...'].join('\n'));
  t.equal(a[0]?.title_norm, b[0]?.title_norm, 'whitespace + en-dash cosmetic variants normalize to the same key');
});
