import test from 'tape-six';

import {
  threadSource,
  trackHeading,
  trackItem,
  closedTrail,
  closedUpstream,
  advisoryOpen,
  localDate,
  repoLinks,
  githubDetail,
  mentionsList
} from '/static/ui/fleet-view.js';

const repo = 'uhop/node-re2';

test('threadSource spells the three sources as fleet-status.mjs file does', t => {
  t.equal(threadSource(repo, 'item', '233'), 'github uhop/node-re2#233');
  t.equal(threadSource(repo, 'discussion', '89'), 'github uhop/node-re2 discussion#89');
  t.equal(
    threadSource(repo, 'advisory', 'GHSA-579h-gqq2-r8cx'),
    'github uhop/node-re2 GHSA-579h-gqq2-r8cx'
  );
});

test('trackHeading shapes the bold title the queue can parse', t => {
  t.equal(
    trackHeading(repo, 'item', '5', 'Crash on empty input'),
    'GitHub: uhop/node-re2#5 — Crash on empty input.'
  );
  t.equal(
    trackHeading(repo, 'item', '5', 'Why?'),
    'GitHub: uhop/node-re2#5 — Why?',
    'end punctuation kept'
  );
  t.equal(
    trackHeading(repo, 'discussion', '89', 'Welcome'),
    'GitHub: uhop/node-re2 discussion #89 — Welcome.'
  );
  t.equal(
    trackHeading(repo, 'advisory', 'GHSA-579h-gqq2-r8cx', 'DoS in matchAll'),
    'GitHub: uhop/node-re2 GHSA-579h-gqq2-r8cx — DoS in matchAll.'
  );
  t.equal(
    trackHeading(repo, 'item', '7', 'A **bold**\nclaim'),
    'GitHub: uhop/node-re2#7 — A *bold* claim.',
    'no ** run and no newline reach the item'
  );
  t.equal(trackHeading(repo, 'item', '8', ''), 'GitHub: uhop/node-re2#8.', 'an empty title');
});

test('trackItem, closedTrail, closedUpstream, localDate', t => {
  t.equal(
    trackItem({
      heading: 'GitHub: uhop/node-re2#5 — Crash.',
      source: 'github uhop/node-re2#5',
      url: 'https://github.com/uhop/node-re2/issues/5',
      date: '2026-09-30'
    }),
    '- **GitHub: uhop/node-re2#5 — Crash.** Tracked from the project page on 2026-09-30: https://github.com/uhop/node-re2/issues/5\n  - source: github uhop/node-re2#5'
  );
  t.ok(
    trackItem({heading: 'H.', source: 'github a/b#1', url: '', date: '2026-09-30'}).includes(
      'on 2026-09-30.\n'
    ),
    'no url, a full stop'
  );
  t.equal(
    closedTrail('2026-09-30', 'merged'),
    '**Closed 2026-09-30**: the thread closed upstream (merged).'
  );
  t.deepEqual(
    [
      {state: 'triage'},
      {state: 'draft'},
      {state: 'published', cve_id: null},
      {state: 'published', cve_id: 'CVE-2026-1'},
      {state: 'closed'}
    ].map(advisoryOpen),
    [true, true, true, false, false],
    'an advisory owes work until it is published with a CVE or closed'
  );
  t.deepEqual([null, 'open', 'published', 'closed', 'merged'].map(closedUpstream), [
    false,
    false,
    false,
    true,
    true
  ]);
  t.equal(localDate(new Date(2026, 0, 5, 23, 30)), '2026-01-05', 'the local calendar day');
});

test('repoLinks: GitHub pages, Discussions only when enabled', t => {
  const base = 'https://github.com/uhop/x';
  t.notOk(repoLinks(base, false).includes('/discussions'));
  const html = repoLinks(base, true);
  for (const path of ['issues', 'pulls', 'actions', 'discussions', 'projects', 'security']) {
    t.ok(html.includes(`href="${base}/${path}"`), path);
  }
});

test('githubDetail marks a tracked thread and offers Track on the rest', t => {
  const baseline = {
    repo,
    html_url: `https://github.com/${repo}`,
    collected_at: '2026-09-30T01:00:00Z',
    meta: {has_discussions: true},
    items: {
      5: {state: 'open', title: 'Tracked one', html_url: `https://github.com/${repo}/issues/5`},
      6: {state: 'open', title: 'Loose one', html_url: `https://github.com/${repo}/issues/6`},
      4: {state: 'closed', title: 'Closed one'}
    },
    discussions: {
      9: {closed: false, title: 'Talk', url: `https://github.com/${repo}/discussions/9`}
    }
  };
  const tracked = [
    {
      title: 'Review five.',
      section: 'active',
      source: 'github UHOP/node-re2#5',
      upstream: 'open',
      url: null
    }
  ];
  const {html, links} = githubDetail({project: 'node-re2', baseline}, [], null, {
    tracked,
    track: true
  });
  t.ok(
    html.includes(
      'on the queue: <a href="/ui/note.html?path=projects%2Fnode-re2%2Fqueue.md">Review five.</a>'
    ),
    'the tracked thread names its item, whatever the case'
  );
  t.ok(html.includes('data-track="github uhop/node-re2#6"'), 'the loose thread gets Track');
  t.notOk(html.includes('data-track="github uhop/node-re2#5"'), 'no Track on a tracked thread');
  t.notOk(html.includes('#4'), 'closed threads are not listed');
  t.ok(html.includes('data-track="github uhop/node-re2 discussion#9"'), 'discussions too');
  t.ok(
    html.includes(`href="https://github.com/${repo}/discussions/9"`),
    'a discussion links by its stored url'
  );
  t.ok(links.includes(`href="https://github.com/${repo}/pulls"`), 'deep links');
  const plain = githubDetail({project: 'node-re2', baseline}, [], null);
  t.notOk(
    plain.html.includes('data-track') || plain.html.includes('on the queue'),
    'no marks without tracked'
  );
  const mentions = new Map([
    [
      'github uhop/node-re2#6',
      {
        key: 'github uhop/node-re2#6',
        url: null,
        mentions: [
          {file_path: 'topics/t.md', title: 'A topic', queue_items: []},
          {
            file_path: 'projects/node-re2/queue.md',
            title: null,
            queue_items: [{title: 'Six.', section: 'active'}]
          }
        ]
      }
    ]
  ]);
  const noted = githubDetail({project: 'node-re2', baseline}, [], null, {mentions}).html;
  t.ok(noted.includes('<summary>2 notes</summary>'), 'a mentioned thread says how many notes');
  t.ok(noted.includes('<a href="/ui/note.html?path=topics%2Ft.md">A topic</a>'), 'each note links');
  t.ok(noted.includes('projects/node-re2/queue.md</a> · Six.'), 'a queue note names its item');
});

test('mentionsList: nothing for no mentions', t => {
  t.equal(mentionsList(undefined), '');
  t.equal(mentionsList({key: 'x', url: null, mentions: []}), '');
});
