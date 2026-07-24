import test from 'tape-six';
import {normalizeTitle, type QueueSection} from '../src/queue/parse.ts';
import {blockedView, readyView, resolveBlockers} from '../src/queue/ready.ts';
import type {QueueItemRow} from '../src/queue/repo.ts';

let nextId = 0;

interface RowSpec {
  project: string;
  section: QueueSection;
  title: string;
  priority?: number;
  position?: number;
  blocked_by?: string[];
}

const row = (spec: RowSpec): QueueItemRow => ({
  id: `row-${++nextId}`,
  project: spec.project,
  section: spec.section,
  priority: spec.priority ?? 0,
  position: spec.position ?? 1,
  title: spec.title,
  title_norm: normalizeTitle(spec.title),
  body: '',
  closed_at: null,
  close_reason: null,
  source_file: `projects/${spec.project}/queue.md`,
  source_line: 1,
  body_hash: `hash-${nextId}`,
  blocked_by: spec.blocked_by ?? [],
  created_at: '2026-07-23T00:00:00Z',
  updated_at: '2026-07-23T00:00:00Z'
});

test('resolveBlockers — ref states', async t => {
  await t.test('open blocker blocks; archived blocker does not', t => {
    const blockerOpen = row({project: 'p', section: 'backlog', title: 'Open blocker.'});
    const blockerDone = row({project: 'p', section: 'archive', title: 'Done blocker.'});
    const item = row({
      project: 'p',
      section: 'backlog',
      title: 'Dependent.',
      blocked_by: ['Open blocker.', 'Done blocker.']
    });
    const universe = [blockerOpen, blockerDone, item];
    const [report] = resolveBlockers([item], universe);
    t.equal(report?.blocked, true);
    t.deepEqual(
      report?.blockers.map(b => [b.ref, b.state]),
      [
        ['Open blocker.', 'open'],
        ['Done blocker.', 'closed']
      ]
    );
    t.equal(report?.blockers[0]?.target?.id, blockerOpen.id);
  });

  await t.test('unresolved ref blocks conservatively', t => {
    const item = row({
      project: 'p',
      section: 'backlog',
      title: 'Dependent.',
      blocked_by: ['no such item']
    });
    const [report] = resolveBlockers([item], [item]);
    t.equal(report?.blocked, true);
    t.equal(report?.blockers[0]?.state, 'unresolved');
  });

  await t.test('substring match resolves; two substring hits are ambiguous', t => {
    const one = row({project: 'p', section: 'backlog', title: 'Fix the flux capacitor.'});
    const item1 = row({
      project: 'p',
      section: 'backlog',
      title: 'Dependent A.',
      blocked_by: ['flux capacitor']
    });
    const [ok] = resolveBlockers([item1], [one, item1]);
    t.equal(ok?.blockers[0]?.state, 'open');

    const two = row({project: 'p', section: 'backlog', title: 'Replace the flux capacitor.'});
    const [ambiguous] = resolveBlockers([item1], [one, two, item1]);
    t.equal(ambiguous?.blockers[0]?.state, 'ambiguous');
    t.equal(ambiguous?.blockers[0]?.matches, 2);
  });

  await t.test('exact title_norm match wins over substring ambiguity', t => {
    const exact = row({project: 'p', section: 'archive', title: 'Ship it.'});
    const noisy = row({project: 'p', section: 'backlog', title: 'Ship it. But bigger.'});
    const item = row({
      project: 'p',
      section: 'backlog',
      title: 'Dependent.',
      blocked_by: ['Ship it.']
    });
    const [report] = resolveBlockers([item], [exact, noisy, item]);
    t.equal(report?.blockers[0]?.state, 'closed');
    t.equal(report?.blockers[0]?.target?.id, exact.id);
  });

  await t.test('cross-project `<project>/<ref>` resolves; local match preferred', t => {
    const remote = row({project: 'other', section: 'backlog', title: 'Remote blocker.'});
    const item = row({
      project: 'p',
      section: 'backlog',
      title: 'Dependent.',
      blocked_by: ['other/Remote blocker.']
    });
    const [report] = resolveBlockers([item], [remote, item]);
    t.equal(report?.blockers[0]?.state, 'open');
    t.equal(report?.blockers[0]?.target?.project, 'other');

    // A slash-bearing ref that matches locally never falls through to the
    // cross-project split.
    const local = row({project: 'p', section: 'backlog', title: 'other/Remote blocker. Local.'});
    const [localFirst] = resolveBlockers([item], [remote, local, item]);
    t.equal(localFirst?.blockers[0]?.target?.project, 'p');
  });
});

test('readyView / blockedView', async t => {
  await t.test('ready = unblocked backlog only, priority DESC', t => {
    const done = row({project: 'p', section: 'archive', title: 'Done.'});
    const free = row({project: 'p', section: 'backlog', title: 'Free.', priority: 1});
    const unblocked = row({
      project: 'p',
      section: 'backlog',
      title: 'Unblocked.',
      blocked_by: ['Done.']
    });
    const stuck = row({project: 'p', section: 'backlog', title: 'Stuck.', blocked_by: ['Free.']});
    const active = row({project: 'p', section: 'active', title: 'Active.'});
    const watching = row({project: 'p', section: 'watching', title: 'Watching.'});
    const universe = [done, free, unblocked, stuck, active, watching];
    t.deepEqual(
      readyView(universe, universe).map(r => r.title),
      ['Free.', 'Unblocked.']
    );
  });

  await t.test('blocked view carries detail; watching items included', t => {
    const free = row({project: 'p', section: 'backlog', title: 'Free.'});
    const stuck = row({
      project: 'p',
      section: 'watching',
      title: 'Stuck.',
      blocked_by: ['Free.', 'typo ref']
    });
    const universe = [free, stuck];
    const reports = blockedView(universe, universe);
    t.equal(reports.length, 1);
    t.deepEqual(
      reports[0]?.blockers.map(b => b.state),
      ['open', 'unresolved']
    );
  });

  await t.test('mutual blockage is flagged as a cycle; a mere dependent is not', t => {
    const a = row({project: 'p', section: 'backlog', title: 'Item A.', blocked_by: ['Item B.']});
    const b = row({project: 'p', section: 'backlog', title: 'Item B.', blocked_by: ['Item A.']});
    const c = row({project: 'p', section: 'backlog', title: 'Item C.', blocked_by: ['Item A.']});
    const universe = [a, b, c];
    const reports = blockedView(universe, universe);
    const byTitle = new Map(reports.map(r => [r.item.title, r]));
    t.equal(byTitle.get('Item A.')?.inCycle, true);
    t.equal(byTitle.get('Item B.')?.inCycle, true);
    t.equal(byTitle.get('Item C.')?.inCycle, false);
    t.deepEqual(readyView(universe, universe), [], 'nothing in a cycle is ever ready');
  });
});
