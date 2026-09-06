import test from 'tape-six';
import {
  completionMarker,
  countMismatch,
  itemCount,
  parseQueue,
  queueFindings
} from '../src/queue/lint.ts';

// The fixture claude-config's queue-lint.test.mjs pins (2026-09-06): the shapes
// the 2026-08-17 fleet audit found and the calibration kept.
const QUEUE = `Intro paragraph mentioning \`## Done\` in code.

- **Stray item above the schema.** Dropped by the parser.

## Design constraints

- **Not work.** Rationale lives here by convention.

## Active

- [x] **Checked item — _implemented 2026-08-18, unreleased._** Done but never moved.
- **Phase 8 — MERGE SHIPPED 2026-07-29: all executed.** Real run.

## Backlog

### Priority +1

- **Remove the deprecated \`utils\` re-exports — next major.** Delegation **SHIPPED** 2026-06-07; only the removal remains.
- **Fix the flaky test.** Filed 2026-08-01; fixed the harness, not the test.
- **Goedecke read — filed and closed 2026-08-16.** Moved to the archive already.
- [ ] Peer-dep bump: wait for parent 3.3.0.
- \`src/index.js\` — default \`keyFromPath\` change.
  - indented detail is not an item
- **Item whose \`code\` title survives.** With a \`span\`.

\`\`\`markdown
## Done

- **Fenced example.** Not a section.
\`\`\`

## Done

- **Shipped thing.** Left under an invented heading.
- [x] checked but unbolded

## See also

- [[projects/x/decisions]]

## Watching

- **~~Locate the proposal~~ — CLOSED 2026-07-21.** Nothing to find.
- **Upstream release.** Waiting.
`;

test('queue lint: sections, items and the preamble parse the way queue_items counts them', t => {
  const parsed = parseQueue(QUEUE);
  t.deepEqual(
    parsed.sections.map(s => [s.heading, s.known, s.prose, s.items.length]),
    [
      ['Design constraints', false, true, 1],
      ['Active', true, false, 2],
      ['Backlog', true, false, 6],
      ['Done', false, false, 2],
      ['See also', false, true, 1],
      ['Watching', true, false, 2]
    ]
  );
  t.equal(parsed.preamble.items.length, 1);
  t.equal(itemCount(parsed), 10);
  t.equal(parsed.sections[2]?.items[5]?.title, 'Item whose `code` title survives.');
});

test('queue lint: completion markers — shouted or dated in the title, checked box, never the description', t => {
  const backlog = parseQueue(QUEUE).sections[2]?.items ?? [];
  t.equal(
    completionMarker(backlog[0]!),
    null,
    'SHIPPED in the description is progress, not closure'
  );
  t.equal(completionMarker(backlog[1]!), null, 'a plain "fixed" with no date is prose');
  t.equal(completionMarker(backlog[2]!), 'closed 2026-08-16');
  const active = parseQueue(QUEUE).sections[1]?.items ?? [];
  t.equal(completionMarker(active[0]!), '[x]');
  t.equal(completionMarker(active[1]!), 'SHIPPED');
  t.equal(
    completionMarker({line: 1, checkbox: null, title: 'Emit `DONE` events.', first: ''}),
    null,
    'code spans are stripped'
  );
});

test('queue lint: findings — the invented heading, the preamble, the markers, the unbolded bullets', t => {
  const out = queueFindings(parseQueue(QUEUE));
  const has = (re: RegExp): void => {
    t.ok(
      out.some(d => re.test(d)),
      `missing ${re}\n${out.join('\n')}`
    );
  };
  has(/^1 item above the first schema H2/);
  has(/^## Done: 2 items under a non-schema H2/);
  has(/^Active "Checked item — _implemented 2026-08-18, unreleased._": completion marker '\[x\]'/);
  has(/^Active "Phase 8 — MERGE SHIPPED 2026-07-29: all executed.": completion marker 'SHIPPED'/);
  has(
    /^Backlog "Goedecke read — filed and closed 2026-08-16.": completion marker 'closed 2026-08-16'/
  );
  has(/^Watching "~~Locate the proposal~~ — CLOSED 2026-07-21.": completion marker 'CLOSED'/);
  has(/^Backlog: 2 unbolded column-0 bullets counted as items, first "Peer-dep bump/);
  t.notOk(
    out.some(d => /Design constraints|See also|Fenced example/.test(d)),
    out.join('\n')
  );
  t.notOk(
    out.some(d => /Remove the deprecated|Fix the flaky/.test(d)),
    out.join('\n')
  );
  t.equal(out.length, 7, out.join('\n'));
});

test('queue lint: a heading glued to the previous line is reported, not treated as a section', t => {
  const parsed = parseQueue(
    '## Active\n\n- **A.** then archive this item.## Backlog\n\n- **B.** open\n'
  );
  t.equal(parsed.sections.length, 1);
  t.equal(itemCount(parsed), 2);
  const out = queueFindings(parsed);
  t.equal(out.length, 1);
  t.matchString(
    out[0] ?? '',
    /^line 3: heading glued to prose — "- \*\*A\.\*\* then archive this item\.## Backlog"/
  );
});

test('queue lint: the shapes parse.ts accepts count the same here', t => {
  // `+` bullets, tab-separated markers, lowercase schema headings, and a bare
  // marker with nothing after it — all read by parse.ts, so counted (or not)
  // identically.
  const parsed = parseQueue(
    '## active\n\n+ **Plus.** ok\n-\t**Tab.** ok\n- \n\n## Backlog\n\n(empty)\n'
  );
  t.equal(itemCount(parsed), 2);
  t.deepEqual(queueFindings(parsed), []);
});

test('queue lint: a clean queue has no findings and an exact count', t => {
  const parsed = parseQueue(
    '## Active\n\n(empty)\n\n## Backlog\n\n- **One.** Open.\n\n## Watching\n\n(empty)\n'
  );
  t.deepEqual(queueFindings(parsed), []);
  t.equal(itemCount(parsed), 1);
  t.equal(countMismatch(1, 1), null);
  t.matchString(
    countMismatch(1, 0) ?? '',
    /^queue_items holds 0 items, the markdown 1 column-0 bullet/
  );
  t.matchString(
    countMismatch(2, 5) ?? '',
    /^queue_items holds 5 items, the markdown 2 column-0 bullets/
  );
});
