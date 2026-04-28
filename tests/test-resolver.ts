import test from 'tape-six';
import {WikilinkResolver} from '../src/importer/resolver.ts';
import type {VaultRecord} from '../src/records/types.ts';

const record = (recordId: string, filePath: string): VaultRecord => ({
  recordId,
  filePath,
  parentPath: null,
  sequenceKey: null,
  type: 'permanent',
  body: '',
  contentHash: 'h',
  created: '2026-04-28',
  updated: '2026-04-28',
  lastReferenced: null,
  decayScore: 1,
  status: 'active',
  priority: 0,
  archivedAt: null
});

test('WikilinkResolver', async t => {
  const records = [
    record('a', 'topics/alpha.md'),
    record('b', 'topics/sub/beta.md'),
    record('c', 'projects/demo/notes.md'),
    record('d1', 'topics/dup.md'),
    record('d2', 'projects/dup.md')
  ];
  const resolver = new WikilinkResolver(records);

  await t.test('exact path with .md', t => {
    t.equal(resolver.resolve('topics/alpha.md'), 'a');
  });
  await t.test('exact path without .md', t => {
    t.equal(resolver.resolve('topics/alpha'), 'a');
  });
  await t.test('nested path', t => {
    t.equal(resolver.resolve('topics/sub/beta'), 'b');
  });
  await t.test('basename when unique', t => {
    t.equal(resolver.resolve('alpha'), 'a');
    t.equal(resolver.resolve('notes'), 'c');
  });
  await t.test('basename ambiguous → null', t => {
    t.equal(resolver.resolve('dup'), null);
  });
  await t.test('unknown target → null', t => {
    t.equal(resolver.resolve('does/not/exist'), null);
    t.equal(resolver.resolve('totally-missing'), null);
  });
  await t.test('whitespace trimmed', t => {
    t.equal(resolver.resolve('  topics/alpha  '), 'a');
  });
  await t.test('empty input → null', t => {
    t.equal(resolver.resolve(''), null);
    t.equal(resolver.resolve('   '), null);
  });
});
