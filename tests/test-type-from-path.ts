import test from 'tape-six';
import {typeFromPath, isRecordType} from '../src/importer/type-from-path.ts';

test('top-level folders map to expected types', t => {
  t.equal(typeFromPath('topics/foo.md'), 'permanent', 'topics → permanent');
  t.equal(typeFromPath('logs/2026-04-28-x.md'), 'log', 'logs → log');
  t.equal(typeFromPath('queries/x.md'), 'query', 'queries → query');
  t.equal(typeFromPath('raw/note.md'), 'fleeting', 'raw → fleeting');
});

test('special filenames take precedence', t => {
  t.equal(typeFromPath('_index.md'), 'index', 'root _index.md → index');
  t.equal(typeFromPath('topics/_about.md'), 'meta', '_about.md anywhere → meta');
  t.equal(typeFromPath('projects/demo/_about.md'), 'meta', 'project _about.md → meta');
  t.equal(typeFromPath('projects/demo/state.md'), 'state', 'project state.md → state');
});

test('projects/<name>/<sub>/... maps to sub-types', t => {
  t.equal(typeFromPath('projects/demo/ideas/x.md'), 'idea', 'ideas → idea');
  t.equal(typeFromPath('projects/demo/design/x.md'), 'design', 'design → design');
  t.equal(typeFromPath('projects/demo/plan/x.md'), 'plan', 'plan → plan');
  t.equal(typeFromPath('projects/demo/queue/x.md'), 'queue-item', 'queue → queue-item');
  t.equal(typeFromPath('projects/demo/research/x.md'), 'research', 'research → research');
  t.equal(typeFromPath('projects/demo/bugs/x.md'), 'bug-report', 'bugs → bug-report');
});

test('projects catch-all is "project"', t => {
  t.equal(typeFromPath('projects/demo/queue.md'), 'project', 'unknown sub → project');
  t.equal(typeFromPath('projects/demo/learnings.md'), 'project', 'top-level project file');
});

test('unknown top-level falls back to "permanent"', t => {
  t.equal(typeFromPath('misc/x.md'), 'permanent', 'unknown folder');
  t.equal(typeFromPath('x.md'), 'permanent', 'root-level file');
});

test('windows-style paths are normalized', t => {
  t.equal(typeFromPath('topics\\x.md'), 'permanent', 'backslash path normalized');
  t.equal(typeFromPath('/topics/x.md'), 'permanent', 'leading slash stripped');
});

test('isRecordType accepts known values, rejects others', t => {
  t.ok(isRecordType('permanent'), 'known type accepted');
  t.ok(isRecordType('queue-item'), 'kebab-case type accepted');
  t.notOk(isRecordType('not-a-type'), 'unknown rejected');
  t.notOk(isRecordType(42), 'non-string rejected');
  t.notOk(isRecordType(null), 'null rejected');
});
