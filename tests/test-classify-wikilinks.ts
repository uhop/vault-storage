import test from 'tape-six';
import {classifyBodyLinks} from '../src/importer/classify-wikilinks.ts';

test('default for un-cued body links is cites', t => {
  const out = classifyBodyLinks('See also [[topics/foo]] for context.');
  t.equal(out.length, 1, 'one link');
  t.equal(out[0]?.type, 'cites', 'default cites');
  t.equal(out[0]?.target, 'topics/foo', 'target preserved');
});

test('"supersedes" → supersedes edge', t => {
  const out = classifyBodyLinks('This decision supersedes [[old-decision]] from last year.');
  t.equal(out[0]?.type, 'supersedes', 'pre-pattern supersedes');
});

test('"replaces" → supersedes edge', t => {
  const out = classifyBodyLinks('The new approach replaces [[old-thing]].');
  t.equal(out[0]?.type, 'supersedes', 'replaces collapses to supersedes');
});

test('"derived from" → derived-from edge', t => {
  const out = classifyBodyLinks('This insight is derived from [[topics/observation]].');
  t.equal(out[0]?.type, 'derived-from', 'derived-from match');
});

test('"caused by" → caused-by edge', t => {
  const out = classifyBodyLinks('The bug was caused by [[bug-root-cause]] in the parser.');
  t.equal(out[0]?.type, 'caused-by', 'caused-by match');
});

test('"fixed by" → fixed-by edge', t => {
  const out = classifyBodyLinks('This was fixed by [[topics/the-fix]] last week.');
  t.equal(out[0]?.type, 'fixed-by', 'fixed-by match');
});

test('"rejected because" → rejected-because edge', t => {
  const out = classifyBodyLinks('We chose A over B; rejected because [[constraint-x]] applies.');
  t.equal(out[0]?.type, 'rejected-because', 'rejected-because match');
});

test('"applies to" pre-pattern → applies-to edge', t => {
  const out = classifyBodyLinks('This rule applies to [[projects/foo]] and similar setups.');
  t.equal(out[0]?.type, 'applies-to', 'applies-to match');
});

test('"[[X]] applies to ..." post-pattern → applies-to edge', t => {
  const out = classifyBodyLinks('[[topics/principle]] applies to many cases.');
  t.equal(out[0]?.type, 'applies-to', 'post-pattern applies-to');
});

test('"contradicts" → contradicts edge', t => {
  const out = classifyBodyLinks('This claim contradicts [[other-claim]] in section 4.');
  t.equal(out[0]?.type, 'contradicts', 'contradicts match');
});

test('case-insensitive matching', t => {
  const out = classifyBodyLinks('Supersedes [[old]] in mixed case.');
  t.equal(out[0]?.type, 'supersedes', 'case-insensitive supersedes');
});

test('multiple links classified independently', t => {
  const body = 'Derived from [[a]] and supersedes [[b]]; also see [[c]].';
  const out = classifyBodyLinks(body);
  const byTarget = new Map(out.map(e => [e.target, e.type]));
  t.equal(byTarget.get('a'), 'derived-from', 'a → derived-from');
  t.equal(byTarget.get('b'), 'supersedes', 'b → supersedes');
  t.equal(byTarget.get('c'), 'cites', 'c → cites (default)');
});

test('same target multiple times collapses to strongest type', t => {
  const body = 'See [[same]] earlier; this supersedes [[same]] now.';
  const out = classifyBodyLinks(body);
  t.equal(out.length, 1, 'collapsed to one entry');
  t.equal(out[0]?.type, 'supersedes', 'strongest type wins');
});

test('keyword far from link does not falsely match', t => {
  // 80-char window; pad with filler so "supersedes" falls outside.
  const filler = ' '.repeat(120);
  const out = classifyBodyLinks(`supersedes${filler}[[x]]`);
  t.equal(out[0]?.type, 'cites', 'distant keyword ignored');
});

test('display label dropped from target', t => {
  const out = classifyBodyLinks('See [[topics/foo|the foo doc]].');
  t.equal(out[0]?.target, 'topics/foo', 'display segment stripped');
});

test('empty body returns empty', t => {
  t.equal(classifyBodyLinks('').length, 0, 'no links');
  t.equal(classifyBodyLinks('plain text, no links').length, 0, 'no links');
});

test('"superseded by" → supersedes edge with inverse direction', t => {
  // Passive form: source is superseded by target → edge target→source.
  const out = classifyBodyLinks('This idea is superseded by [[new-design]].');
  t.equal(out[0]?.type, 'supersedes');
  t.equal(out[0]?.inverse, true, 'inverse direction set');
});

test('"replaced by" → supersedes edge with inverse direction', t => {
  const out = classifyBodyLinks('The old approach was replaced by [[new-approach]].');
  t.equal(out[0]?.type, 'supersedes');
  t.equal(out[0]?.inverse, true);
});

test('"extends" → derived-from edge', t => {
  const out = classifyBodyLinks(
    '## Relationship\nExtends [[base-design]]: first try the simple case.'
  );
  t.equal(out[0]?.type, 'derived-from');
  t.notOk(out[0]?.inverse, 'active form, no inverse');
});

test('"extending" → derived-from edge', t => {
  const out = classifyBodyLinks('Extending [[parent-pattern]] with one extra step.');
  t.equal(out[0]?.type, 'derived-from');
});

test('"builds on" → derived-from edge', t => {
  const out = classifyBodyLinks('Builds on [[foundation]] but adds caching.');
  t.equal(out[0]?.type, 'derived-from');
});

test('wikilinks inside fenced code blocks are skipped', t => {
  const body = [
    'intro [[real]]',
    '```bash',
    'if [[ -n $x ]]; then echo "[[fake]]"; fi',
    '```',
    'after [[also-real]]'
  ].join('\n');
  const out = classifyBodyLinks(body);
  const targets = out.map(e => e.target).sort();
  t.deepEqual(targets, ['also-real', 'real']);
});

test('inverse and direct edges to same target coexist', t => {
  // Hypothetical: source mentions [[X]] casually elsewhere AND is superseded by [[X]].
  const body = 'See [[X]] for context. This was superseded by [[X]].';
  const out = classifyBodyLinks(body);
  // Strongest active rule wins per direction; inverse is its own bucket.
  const direct = out.find(e => !e.inverse);
  const inverse = out.find(e => e.inverse);
  t.ok(direct, 'has a direct edge');
  t.ok(inverse, 'has an inverse edge');
  t.equal(inverse?.type, 'supersedes');
});
