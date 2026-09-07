import test from 'tape-six';
import {findSection, replaceSectionContent, sectionContent} from '../src/markdown/sections.ts';

const DOC = [
  'Intro.',
  '',
  '## Active',
  '',
  '(empty)',
  '',
  '## Backlog',
  '',
  '- **One.** First.',
  '',
  '### Notes',
  '',
  'Sub-section text.',
  '',
  '```',
  '## Backlog',
  'fenced, not a heading',
  '```',
  '',
  'Inline `## Backlog` is not a heading either.',
  '',
  '## Watching',
  '',
  'Watch text.',
  ''
].join('\n');

test('findSection: whole-line match, fences masked, span to the next same-or-higher heading', async t => {
  const found = findSection(DOC, '## Backlog');
  t.ok(found.ok, 'found exactly once despite the fenced and inline copies');
  if (!found.ok) return;
  t.equal(found.span.level, 2);
  t.equal(found.span.heading, '## Backlog');
  t.equal(
    sectionContent(DOC, found.span),
    [
      '- **One.** First.',
      '',
      '### Notes',
      '',
      'Sub-section text.',
      '',
      '```',
      '## Backlog',
      'fenced, not a heading',
      '```',
      '',
      'Inline `## Backlog` is not a heading either.'
    ].join('\n'),
    'the subsection and the fenced copy belong to the section'
  );

  const sub = findSection(DOC, '### Notes');
  t.ok(sub.ok, 'a subsection is addressable on its own');
  if (sub.ok) {
    t.equal(sub.span.level, 3);
    t.equal(
      sectionContent(DOC, sub.span),
      [
        'Sub-section text.',
        '',
        '```',
        '## Backlog',
        'fenced, not a heading',
        '```',
        '',
        'Inline `## Backlog` is not a heading either.'
      ].join('\n'),
      'a level-3 span ends at the next level-2 heading'
    );
  }

  const last = findSection(DOC, '## Watching');
  t.ok(last.ok && last.span.end === DOC.length, 'the last section runs to the end of the body');
});

test('findSection: absent, ambiguous, fence-only, and trailing-space headings', async t => {
  t.deepEqual(findSection(DOC, '## Nope'), {ok: false, occurrences: 0}, 'absent → 0');
  t.deepEqual(
    findSection(DOC + '\n## Active\n', '## Active'),
    {ok: false, occurrences: 2},
    'twice → 2'
  );
  t.deepEqual(
    findSection('```\n## Only\n```\n', '## Only'),
    {ok: false, occurrences: 0},
    'a heading only inside a fence is not found'
  );
  t.ok(findSection(DOC, '  ## Active  ').ok, 'the wanted heading is trimmed');
  t.ok(
    findSection('## Trail   \n\nx\n', '## Trail').ok,
    'trailing spaces on the document line are ignored'
  );
});

test('replaceSectionContent: bytes outside the span untouched, content framed, empty keeps the heading', async t => {
  const backlog = findSection(DOC, '## Backlog');
  if (!backlog.ok) return t.fail('precondition');
  const out = replaceSectionContent(DOC, backlog.span, '\n\n- **Two.** Second.\n\n\n');
  const expected = [
    'Intro.',
    '',
    '## Active',
    '',
    '(empty)',
    '',
    '## Backlog',
    '',
    '- **Two.** Second.',
    '',
    '## Watching',
    '',
    'Watch text.',
    ''
  ].join('\n');
  t.equal(out, expected, 'trimmed content, one blank line each side, nothing else moved');

  const emptied = replaceSectionContent(DOC, backlog.span, '');
  t.ok(
    emptied.includes('\n## Backlog\n\n## Watching\n'),
    'an empty body leaves heading, blank line, next heading'
  );

  const last = findSection(DOC, '## Watching');
  if (!last.ok) return t.fail('precondition');
  t.ok(
    replaceSectionContent(DOC, last.span, 'Tail.').endsWith('\n## Watching\n\nTail.\n'),
    'the last section ends with a single newline'
  );
  t.ok(
    replaceSectionContent(DOC, last.span, '').endsWith('\n## Watching\n'),
    'an emptied last section ends right after its heading'
  );

  const noNewline = '## Only';
  const only = findSection(noNewline, '## Only');
  if (!only.ok) return t.fail('precondition');
  t.equal(
    replaceSectionContent(noNewline, only.span, 'x'),
    '## Only\n\nx\n',
    'a heading with no newline gains one'
  );
});
