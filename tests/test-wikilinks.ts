import test from 'tape-six';
import {extractRelatedFromFrontmatter, extractWikilinks, maskCodeRegions} from '../src/markdown/wikilinks.ts';

test('extractWikilinks', async t => {
  await t.test('finds a single link', t => {
    t.deepEqual(extractWikilinks('see [[foo]]'), ['foo']);
  });
  await t.test('drops the |display segment', t => {
    t.deepEqual(extractWikilinks('[[foo|the foo]]'), ['foo']);
  });
  await t.test('returns multiple links in encounter order', t => {
    t.deepEqual(extractWikilinks('a [[x]] b [[y]] c [[z|Z]]'), ['x', 'y', 'z']);
  });
  await t.test('handles nested-path targets', t => {
    t.deepEqual(extractWikilinks('see [[topics/sub/foo]]'), ['topics/sub/foo']);
  });
  await t.test('returns empty when no links', t => {
    t.deepEqual(extractWikilinks('plain prose, no brackets'), []);
  });
  await t.test('trims whitespace inside brackets', t => {
    t.deepEqual(extractWikilinks('[[  foo  ]]'), ['foo']);
  });
  await t.test('ignores unclosed [[', t => {
    t.deepEqual(extractWikilinks('start [[unclosed and [[ok]]'), ['ok']);
  });
  await t.test('skips wikilinks inside fenced code blocks', t => {
    const text = ['before [[real]]', '```bash', 'if [[ -z $x ]]; then echo [[fake]]; fi', '```', 'after [[also-real]]'].join('\n');
    t.deepEqual(extractWikilinks(text), ['real', 'also-real']);
  });
  await t.test('skips wikilinks in tilde-fenced code blocks', t => {
    const text = ['[[real]]', '~~~', '[[fake]]', '~~~'].join('\n');
    t.deepEqual(extractWikilinks(text), ['real']);
  });
  await t.test('skips wikilinks inside inline code spans', t => {
    t.deepEqual(extractWikilinks('see `[[fake]]` and [[real]]'), ['real']);
  });
  await t.test('skips POSIX character class lookalikes', t => {
    t.deepEqual(extractWikilinks('regex: `[[:cntrl:]]` matches'), []);
  });
  await t.test('drops pure-anchor links', t => {
    t.deepEqual(extractWikilinks('jump to [[#section]]'), []);
  });
  await t.test('keeps cross-doc anchor target intact (anchor stripped at resolve)', t => {
    t.deepEqual(extractWikilinks('see [[Page#section]]'), ['Page#section']);
  });
});

test('maskCodeRegions', async t => {
  await t.test('preserves indices (replaces with same-length whitespace)', t => {
    const input = 'a `code` b';
    const masked = maskCodeRegions(input);
    t.equal(masked.length, input.length);
    t.equal(masked.indexOf('b'), input.indexOf('b'));
  });
  await t.test('does not blank fenced delimiters across newlines', t => {
    const input = ['a', '```', 'inside', '```', 'b'].join('\n');
    const masked = maskCodeRegions(input);
    t.ok(masked.includes('a'));
    t.ok(masked.includes('b'));
    t.ok(!masked.includes('inside'));
  });
});

test('extractRelatedFromFrontmatter', async t => {
  await t.test('parses an array of wikilink strings', t => {
    const data = {related: ['[[topics/foo]]', '[[bar]]', '[[baz|the baz]]']};
    t.deepEqual(extractRelatedFromFrontmatter(data), ['topics/foo', 'bar', 'baz']);
  });
  await t.test('returns empty when related: is missing', t => {
    t.deepEqual(extractRelatedFromFrontmatter({title: 'X'}), []);
  });
  await t.test('returns empty when related: is not an array', t => {
    t.deepEqual(extractRelatedFromFrontmatter({related: 'not an array'}), []);
  });
  await t.test('skips non-string array items', t => {
    const data = {related: ['[[foo]]', 42, null, '[[bar]]']};
    t.deepEqual(extractRelatedFromFrontmatter(data), ['foo', 'bar']);
  });
});
