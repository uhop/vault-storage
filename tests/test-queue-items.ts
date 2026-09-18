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
    removeItem(DOC, last.span).endsWith('## Watching\n\n(empty)\n'),
    'removing the last item of the last section leaves the placeholder and one newline'
  );
});

test('removeItem: a schema section left with nothing gets the bare (empty), and nothing else does', t => {
  const remove = (doc: string, title: string): string => {
    const found = findItem(doc, title);
    if (!found.ok) throw new Error(`precondition: ${title}`);
    return removeItem(doc, found.span);
  };
  t.equal(
    remove('## Active\n\n- **Only.** x\n\n## Backlog\n\n- **B.** y\n', 'Only.'),
    '## Active\n\n(empty)\n\n## Backlog\n\n- **B.** y\n',
    'the only Active item'
  );
  t.equal(
    remove('## Active\n\n- **One.** x\n\n- **Two.** y\n\n## Backlog\n', 'One.'),
    '## Active\n\n- **Two.** y\n\n## Backlog\n',
    'one of two: no placeholder'
  );
  t.equal(
    remove('## Backlog\n\n- **Direct.** x\n\n### P1\n\n- **Deep.** y\n', 'Direct.'),
    '## Backlog\n\n### P1\n\n- **Deep.** y\n',
    'a subsection is content: no placeholder'
  );
  t.equal(
    remove('## Backlog\n\n### P1\n\n- **Deep.** y\n\n## Watching\n', 'Deep.'),
    '## Backlog\n\n### P1\n\n## Watching\n',
    'the last item of a subsection: not a schema section, no placeholder'
  );
  t.equal(
    remove('## 2026-09-17\n\n- **Shipped.** x\n\n## 2026-09-16\n\n- **Older.** y\n', 'Shipped.'),
    '## 2026-09-17\n\n## 2026-09-16\n\n- **Older.** y\n',
    'an archive date block is not a schema section'
  );
  t.equal(
    remove('## active\n\n```\n## Backlog\n```\n\n- **Only.** x\n', 'Only.'),
    '## active\n\n```\n## Backlog\n```\n',
    'a fence no item owns is content; the heading matches case-insensitively'
  );
  t.equal(
    remove('## Watching\n\n- **Only.** x\n\n```\nfenced\n```\n', 'Only.'),
    '## Watching\n\n(empty)\n',
    'a fence under the item is the item’s, and goes with it'
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
  const embellished = DOC.replace(
    '(empty)',
    '(empty — last shipped 1.2.2 on 2026-07-10; see the archive.)'
  );
  const intoEmbellished = insertItem(embellished, '## Active', '- **Now.** Started.', 'end', false);
  t.ok(
    intoEmbellished.ok &&
      intoEmbellished.body.includes('## Active\n\n- **Now.** Started.\n\n## Backlog') &&
      !intoEmbellished.body.includes('(empty'),
    'an embellished placeholder is replaced too'
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

// The witness apodictum 0379391a51b8 served against the first isPlaceholder (2026-09-16):
// "no blank line inside" is a proxy for "one paragraph", and a column-0 item glued right
// under the placeholder line passed it — insert-item then replaced the section, item and all.
test('insertItem: a placeholder is one paragraph — a glued item, an empty section, and a blank-line tail', t => {
  const glued = '## Active\n\n(empty)\n- **Glued.** x\n\n## Backlog\n\n- **B.** y\n';
  const kept = insertItem(glued, '## Active', '- **New.** z', 'end', false);
  t.ok(
    kept.ok && kept.body.includes('- **Glued.** x') && kept.body.includes('- **New.** z'),
    'an item glued under the placeholder line survives the insert'
  );
  const embellishedGlued = glued.replace('(empty)', '(empty — last shipped 1.0.0.)');
  const keptToo = insertItem(embellishedGlued, '## Active', '- **New.** z', 'end', false);
  t.ok(keptToo.ok && keptToo.body.includes('- **Glued.** x'), 'and under an embellished one');
  const fenced = '## Active\n\n(empty)\n```\ncode\n```\n\n## Backlog\n\n- **B.** y\n';
  const keptFence = insertItem(fenced, '## Active', '- **New.** z', 'end', false);
  t.ok(keptFence.ok && keptFence.body.includes('```\ncode\n```'), 'a glued fence survives too');

  const empty = '## Active\n\n## Backlog\n\n- **B.** y\n';
  const intoEmpty = insertItem(empty, '## Active', '- **New.** z', 'end', false);
  t.equal(
    intoEmpty.ok ? intoEmpty.body : '',
    '## Active\n\n- **New.** z\n\n## Backlog\n\n- **B.** y\n',
    'an empty section takes the item framed by blank lines'
  );

  const tail = '## Active\n\n(empty)\n\nProse after a blank line.\n\n## Backlog\n\n- **B.** y\n';
  const withTail = insertItem(tail, '## Active', '- **New.** z', 'end', false);
  t.ok(
    withTail.ok &&
      withTail.body.includes('(empty)') &&
      withTail.body.includes('Prose after a blank line.\n\n- **New.** z'),
    'a placeholder followed by a second block is not a placeholder-only section'
  );

  // The three regions the apodictum audit (c1f687a4c290, 409ef47f9eee) found no test reaching.
  const watching = insertItem(DOC, '## Watching', '- **New.** z', 'end', false);
  t.ok(
    watching.ok && watching.body.includes('- **Watched.** Upstream.\n\n- **New.** z'),
    'a one-line section that is not a placeholder keeps its line'
  );
  const lazy =
    '## Active\n\n(empty — last shipped 1.0\non 2026-09-01.)\n\n## Backlog\n\n- **B.** y\n';
  const lazyReplaced = insertItem(lazy, '## Active', '- **New.** z', 'end', false);
  t.equal(
    lazyReplaced.ok ? lazyReplaced.body : '',
    '## Active\n\n- **New.** z\n\n## Backlog\n\n- **B.** y\n',
    'a placeholder wrapped over two lines is still one paragraph'
  );
  const heading = '## Active\n\n(empty)\n### Sub\n- **Glued.** x\n\n## Backlog\n\n- **B.** y\n';
  const headingKept = insertItem(heading, '## Active', '- **New.** z', 'end', false);
  t.ok(
    headingKept.ok && headingKept.body.includes('(empty)\n### Sub\n- **Glued.** x\n\n- **New.** z'),
    'a heading glued under the placeholder line ends the paragraph'
  );
});
