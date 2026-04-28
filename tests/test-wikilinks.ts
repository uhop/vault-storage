import test from 'tape-six';
import {extractRelatedFromFrontmatter, extractWikilinks} from '../src/markdown/wikilinks.ts';

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
