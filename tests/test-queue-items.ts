import test from 'tape-six';
import {findItem, insertItem, itemText, removeItem, withTrail} from '../src/queue/items.ts';

const DOC = [
  'Intro.',
  '',
  '## Active',
  '',
  '(empty)',
  '',
  '## Backlog',
  '',
  '- **First.** One line.',
  '',
  '- **Second — with dash.** Two',
  '  lines, indented continuation.',
  '',
  '  A paragraph inside the item.',
  '',
  '```',
  '- **Not an item.** fenced',
  '```',
  '',
  '- **Third.** Last in Backlog.',
  '',
  '## Watching',
  '',
  '- **Watched.** Upstream.',
  ''
].join('\n');

test('findItem: by normalized bold title, scoped by section, fences masked, span to the next bullet or heading', async t => {
  const second = findItem(DOC, 'second - WITH dash.');
  t.ok(second.ok, 'hyphen and case variants normalize');
  if (second.ok) {
    t.equal(second.span.title, 'Second — with dash.');
    t.equal(
      itemText(DOC, second.span),
      [
        '- **Second — with dash.** Two',
        '  lines, indented continuation.',
        '',
        '  A paragraph inside the item.',
        '',
        '```',
        '- **Not an item.** fenced',
        '```'
      ].join('\n'),
      'continuation, inner paragraph, and the fenced bullet belong to the item'
    );
  }
  t.deepEqual(
    findItem(DOC, 'Not an item.'),
    {ok: false, occurrences: 0},
    'a fenced bullet is not an item'
  );
  t.deepEqual(findItem(DOC, 'Nope.'), {ok: false, occurrences: 0});
  t.ok(findItem(DOC, 'Watched.', '## Watching').ok, 'scoped find');
  t.deepEqual(findItem(DOC, 'Watched.', '## Backlog'), {ok: false, occurrences: 0}, 'scoped miss');
  t.deepEqual(findItem(DOC, 'Third.', '## Nope'), {ok: false, occurrences: 0}, 'absent section');
  const twice = DOC + '\n- **First.** again\n';
  t.deepEqual(findItem(twice, 'First.'), {ok: false, occurrences: 2}, 'ambiguous');
  const third = findItem(DOC, 'Third.');
  t.ok(third.ok && third.span.end === 21, 'the last Backlog item ends at the Watching heading');
});

test('removeItem: the block and its trailing blank line go, nothing else moves', async t => {
  const second = findItem(DOC, 'Second — with dash.');
  if (!second.ok) return t.fail('precondition');
  const out = removeItem(DOC, second.span);
  t.equal(
    out,
    [
      'Intro.',
      '',
      '## Active',
      '',
      '(empty)',
      '',
      '## Backlog',
      '',
      '- **First.** One line.',
      '',
      '- **Third.** Last in Backlog.',
      '',
      '## Watching',
      '',
      '- **Watched.** Upstream.',
      ''
    ].join('\n')
  );
  const last = findItem(DOC, 'Watched.');
  if (!last.ok) return t.fail('precondition');
  t.ok(
    removeItem(DOC, last.span).endsWith('## Watching\n'),
    'removing the last item keeps one newline'
  );
});

test('insertItem: start and end, the (empty) placeholder, and a created section', async t => {
  const atEnd = insertItem(DOC, '## Backlog', '- **Fourth.** New.\n', 'end', false);
  t.ok(
    atEnd.ok &&
      atEnd.body.includes('- **Third.** Last in Backlog.\n\n- **Fourth.** New.\n\n## Watching'),
    'end: after the last item, blank lines around'
  );
  const atStart = insertItem(DOC, '## Backlog', '- **Zero.** New.', 'start', false);
  t.ok(
    atStart.ok && atStart.body.includes('## Backlog\n\n- **Zero.** New.\n\n- **First.** One line.'),
    'start: right under the heading'
  );
  const active = insertItem(DOC, '## Active', '- **Now.** Started.', 'end', false);
  t.ok(
    active.ok &&
      active.body.includes('## Active\n\n- **Now.** Started.\n\n## Backlog') &&
      !active.body.includes('(empty)'),
    'placeholder replaced'
  );
  t.deepEqual(
    insertItem(DOC, '## Nope', '- **X.**', 'end', false),
    {ok: false, occurrences: 0},
    'absent heading refused'
  );
  const archive = ['Archive intro.', '', '## 2026-09-05', '', '- **Old.** x', ''].join('\n');
  const created = insertItem(archive, '## 2026-09-06', '- **New.** y', 'end', true);
  t.ok(created.ok && created.created, 'created');
  if (created.ok) {
    t.equal(
      created.body,
      [
        'Archive intro.',
        '',
        '## 2026-09-06',
        '',
        '- **New.** y',
        '',
        '## 2026-09-05',
        '',
        '- **Old.** x',
        ''
      ].join('\n'),
      'new block before the first heading of the same level'
    );
  }
  const onlyIntro = insertItem('Intro only.\n', '## 2026-09-06', '- **New.** y', 'end', true);
  t.ok(
    onlyIntro.ok && onlyIntro.body === 'Intro only.\n\n## 2026-09-06\n\n- **New.** y\n',
    'appended when no heading exists'
  );
});

test('withTrail: after the bold title, one space, continuation kept', async t => {
  t.equal(
    withTrail('- **Title.** Desc.\n  more', '**Shipped.** trail'),
    '- **Title.** **Shipped.** trail Desc.\n  more'
  );
  t.equal(withTrail('- plain bullet', 'x'), '- plain bullet', 'no bold title: unchanged');
});
