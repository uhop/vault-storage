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
  title: null,
  created: '2026-04-28',
  updated: '2026-04-28',
  lastReferenced: null,
  decayScore: 1,
  status: 'active',
  priority: 0,
  archivedAt: null,
  agentSummary: null,
  agentDerivedFromHash: null
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
  await t.test('strips #anchor before lookup', t => {
    t.equal(resolver.resolve('topics/alpha#some-section'), 'a');
    t.equal(resolver.resolve('alpha#another'), 'a');
  });
  await t.test('pure-anchor target → null', t => {
    t.equal(resolver.resolve('#heading'), null);
  });
});

test('WikilinkResolver: folder fallback to _about.md', async t => {
  const records = [
    record('about', 'projects/blog/decisions/_about.md'),
    record('p1', 'projects/blog/decisions/api-design.md'),
    record('p2', 'projects/blog/decisions/auth-flow.md')
  ];
  const resolver = new WikilinkResolver(records);

  await t.test('legacy file-level link redirects to folder _about.md', t => {
    t.equal(resolver.resolve('projects/blog/decisions'), 'about', 'folder → _about.md');
    t.equal(resolver.resolve('projects/blog/decisions.md'), 'about', 'with .md → _about.md');
  });

  await t.test('exact piece path still wins over folder fallback', t => {
    t.equal(resolver.resolve('projects/blog/decisions/api-design'), 'p1', 'piece path resolves directly');
    t.equal(resolver.resolve('projects/blog/decisions/api-design.md'), 'p1', 'piece path with .md');
  });

  await t.test('folder without _about.md does not match', t => {
    const noAbout = [
      record('p', 'projects/blog/decisions/api-design.md')
    ];
    const r2 = new WikilinkResolver(noAbout);
    t.equal(r2.resolve('projects/blog/decisions'), null, 'no _about.md, no fallback');
  });
});
