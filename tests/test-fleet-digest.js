import test from 'tape-six';

import {
  parseRuns,
  parseBaseline,
  storedMovement,
  brief,
  briefText,
  phraseText,
  baselineRow,
  baselineDetail,
  alertText,
  short,
  clip,
  plural,
  parsePackages,
  fourWeekChange,
  latestMajorShare,
  latestVersionShare,
  wholeShare,
  majorShares,
  dependentsChange,
  weekEnds,
  packageRows,
  compact,
  percent,
  majorOf,
  compareVersions,
  repoGlance,
  answered,
  packageMovement
} from '/static/ui/fleet-digest.js';

// A collected digest in the shape `fleet-status.mjs collect` writes. The
// expected brief below is that script's own rendering of it
// (`fleet-status.mjs show fixture.json --brief`, 2026-09-07), so the port is
// held to the renderer it mirrors rather than to a hand-written idea of it.
const DIGEST = {
  collected_at: '2026-09-07T16:42:25.895Z',
  mode: 'fleet',
  gh_user: 'octo',
  totals: {repos: 6, events: 12, first_run: 1, errors: 1, partial_errors: 1},
  repos: [
    {
      repo: 'octo/alpha',
      project: 'alpha',
      first_run: false,
      since: '2026-09-01T10:00:00.000Z',
      events: [
        {
          kind: 'issue.new',
          repo: 'octo/alpha',
          number: 30,
          title: 'Build fails on Corepack',
          author: 'rainecheck',
          bot: false,
          url: 'https://github.com/octo/alpha/issues/30',
          state: 'open',
          comments: 0,
          reactions: 0,
          excerpt:
            'The verify step runs npm even when the package manager is pnpm, which breaks on a minimal image.'
        },
        {
          kind: 'issue.comments',
          repo: 'octo/alpha',
          number: 30,
          title: 'Build fails on Corepack',
          author: 'rainecheck',
          bot: false,
          url: 'https://github.com/octo/alpha/issues/30',
          delta: 1,
          total: 1,
          last_comment: {author: 'octo', at: '2026-09-05T08:00:00Z', excerpt: 'Thanks, looking.'}
        },
        {
          kind: 'pr.comments',
          repo: 'octo/alpha',
          number: 12,
          title: 'Bump the npm-deps group across 1 directory with 3 updates',
          author: 'dependabot[bot]',
          bot: true,
          url: 'https://github.com/octo/alpha/pull/12',
          delta: 1,
          total: 1,
          last_comment: {
            author: 'dependabot[bot]',
            at: '2026-09-04T01:22:41Z',
            excerpt:
              'Looks like these dependencies are updatable in another way, so this is no longer needed.'
          }
        },
        {
          kind: 'pr.state',
          repo: 'octo/alpha',
          number: 12,
          title: 'Bump the npm-deps group across 1 directory with 3 updates',
          author: 'dependabot[bot]',
          bot: true,
          url: 'https://github.com/octo/alpha/pull/12',
          from: 'open',
          to: 'closed'
        },
        {
          kind: 'pr.new',
          repo: 'octo/alpha',
          number: 13,
          title: 'Bump tape-six from 1.16.2 to 1.16.4',
          author: 'dependabot[bot]',
          bot: true,
          url: 'https://github.com/octo/alpha/pull/13',
          state: 'open',
          comments: 0,
          reactions: 0,
          excerpt: 'Bumps tape-six.'
        }
      ],
      summary: {events: 5, open_items: 2, advisories_without_cve: 0, stars: 7, forks: 1},
      errors: [{where: 'discussions', message: 'GraphQL rate limited'}]
    },
    {
      repo: 'octo/beta',
      project: 'beta',
      first_run: false,
      since: '2026-09-02T10:00:00.000Z',
      events: [
        {kind: 'stars.count', repo: 'octo/beta', from: 5, to: 6, delta: 1},
        {
          kind: 'alerts.dependabot',
          repo: 'octo/beta',
          from: 0,
          to: 5,
          by_severity: {high: 2, moderate: 3}
        },
        {kind: 'fork.new', repo: 'octo/beta', login: 'forker', full_name: 'forker/beta'},
        {
          kind: 'ci.conclusion',
          repo: 'octo/beta',
          name: 'Node.js CI',
          from: 'success',
          to: 'failure',
          html_url: 'https://github.com/octo/beta/actions/runs/1'
        }
      ],
      summary: {events: 4, open_items: 0, advisories_without_cve: 0, stars: 6, forks: 2},
      errors: []
    },
    {
      repo: 'octo/gamma',
      project: 'gamma',
      first_run: false,
      since: '2026-09-01T10:00:00.000Z',
      events: [
        {
          kind: 'advisory.new',
          repo: 'octo/gamma',
          id: 'GHSA-xxxx-yyyy-zzzz',
          state: 'published',
          severity: 'high',
          cve_id: null,
          summary: 'ReDoS in the parser',
          html_url: 'https://github.com/octo/gamma/security/advisories/GHSA-xxxx-yyyy-zzzz'
        },
        {
          kind: 'release.new',
          repo: 'octo/gamma',
          tag: '2.1.0',
          name: '2.1.0',
          draft: false,
          prerelease: false,
          html_url: 'https://github.com/octo/gamma/releases/tag/2.1.0'
        },
        {kind: 'alerts.code_scanning', repo: 'octo/gamma', from: 3, to: 1, by_severity: {}},
        {
          kind: 'package.dependents',
          repo: 'octo/gamma',
          package: 'gamma',
          from: 40,
          to: 43,
          delta: 3
        }
      ],
      summary: {events: 3, open_items: 0, advisories_without_cve: 1, stars: 20, forks: 3},
      errors: []
    },
    {
      repo: 'octo/delta',
      project: 'delta',
      first_run: true,
      since: null,
      events: [],
      summary: {events: 0, open_items: 2, advisories_without_cve: 0, stars: 4, forks: 1},
      errors: []
    },
    {
      repo: 'octo/epsilon',
      project: 'epsilon',
      error: {message: 'HTTP 404'},
      events: [],
      summary: null
    },
    {
      repo: 'octo/zeta',
      project: 'zeta',
      first_run: false,
      since: '2026-09-03T10:00:00.000Z',
      events: [],
      summary: {events: 0, open_items: 0, advisories_without_cve: 0, stars: 1, forks: 0},
      errors: []
    },
    {
      repo: 'others/eta',
      project: 'others-eta',
      github: false,
      events: [
        {
          kind: 'package.dependents',
          repo: 'others/eta',
          package: '@others/eta',
          from: 9,
          to: 8,
          delta: -1
        }
      ],
      summary: {events: 1},
      errors: []
    }
  ]
};

const EXPECTED_BRIEF = [
  'Fleet movement since 2026-09-01 10:00 — 6 repositories, 3 with movement',
  '- gamma: advisory GHSA-xxxx-yyyy-zzzz (published, high) "ReDoS in the parser"; release 2.1.0',
  '- alpha: new issue #30 by rainecheck "Build fails on Corepack" — The verify step runs npm even when the package manager is pnpm, which breaks…; PR #12 "Bump the npm-deps group across 1 directory with…" +1 comment by dependabot[bot]: "Looks like these dependencies are updatable in another way, so this is no…"; PR #12 "Bump the npm-deps group across 1 directory with…" open → closed',
  '- beta: Dependabot alerts 0 → 5; CI Node.js CI: success → failure',
  '- counters: stars +1 (beta +1); forks +1 (beta +1: forker); dependents +2 (gamma +3, @others/eta -1); bots: PR alpha#13 by dependabot[bot]; alerts down (gamma code scanning 3 → 1)',
  '- first run: 1 repository (baseline recorded)',
  '- errors: epsilon: HTTP 404',
  '- partial errors: 1 (details in the collected JSON)',
  '- quiet: 1 repository'
].join('\n');

const run = (collected_at, mode, repos, totals) => ({
  collected_at,
  mode,
  gh_user: 'octo',
  totals: {repos: repos.length, events: 0, first_run: 0, errors: 0, ...totals},
  repos
});
const fence = obj => '```json\n' + JSON.stringify(obj, null, 2) + '\n```';

const OLDER = run(
  '2026-09-05T12:00:00.000Z',
  'fleet',
  [
    {
      repo: 'octo/alpha',
      project: 'alpha',
      first_run: false,
      since: '2026-09-01T00:00:00.000Z',
      events: [
        {
          kind: 'pr.state',
          repo: 'octo/alpha',
          number: 12,
          title: 'Bump deps',
          author: 'dependabot[bot]',
          bot: true,
          url: 'https://github.com/octo/alpha/pull/12',
          from: 'open',
          to: 'closed'
        }
      ],
      summary: {events: 1},
      errors: []
    },
    {repo: 'octo/beta', project: 'beta', first_run: true, since: null, events: [], errors: []},
    {repo: 'octo/zeta', project: 'zeta', first_run: false, since: null, events: [], errors: []}
  ],
  {events: 1, first_run: 1}
);
const NEWER = run('2026-09-06T12:00:00.000Z', 'cwd', [
  {
    repo: 'octo/alpha',
    project: 'alpha',
    first_run: false,
    since: '2026-09-05T12:00:00.000Z',
    events: [
      {
        kind: 'issue.new',
        repo: 'octo/alpha',
        number: 31,
        title: 'Crash on empty input',
        author: 'someone',
        bot: false,
        url: 'https://github.com/octo/alpha/issues/31',
        state: 'open',
        comments: 0,
        reactions: 0
      }
    ],
    summary: {events: 1},
    errors: []
  }
]);

const DIGEST_DOC = [
  '---\ntitle: Fleet status — GitHub digest\ntype: state\n---\nIntro prose.',
  '## 2026-09-05T12:00:00Z\n\nMode: fleet.\n\n' + fence(OLDER),
  '## 2026-08-20T12:00:00Z\n\nProse-only section from before the json blocks.',
  '## 2026-09-06T12:00:00Z\n\nMode: cwd.\n\n' + fence(NEWER)
].join('\n\n');

const BASELINE = {
  repo: 'octo/alpha',
  html_url: 'https://github.com/octo/alpha',
  collected_at: '2026-09-07T16:44:44.721Z',
  window: {since: '2026-09-07T16:42:19.524Z', first_run: false},
  meta: {stars: 7, forks: 1, watchers: 2, open_issues: 2, has_discussions: true},
  advisories: {
    'GHSA-aaaa': {
      state: 'published',
      severity: 'high',
      cve_id: 'CVE-2026-1',
      published_at: '2026-08-01T00:00:00Z',
      summary: 'A'
    },
    'GHSA-bbbb': {
      state: 'published',
      severity: 'moderate',
      cve_id: null,
      published_at: '2026-09-01T00:00:00Z',
      summary: 'B'
    },
    'GHSA-cccc': {state: 'draft', severity: 'low', cve_id: null, published_at: null, summary: 'C'}
  },
  items: {
    30: {
      is_pr: false,
      title: 'Old issue',
      state: 'open',
      author: 'a',
      bot: false,
      updated_at: '2026-08-01T00:00:00Z',
      comments: 1,
      review_comments: 0,
      reactions: 0,
      comment_reactions: 0,
      last_comment: null,
      html_url: 'https://github.com/octo/alpha/issues/30',
      draft: false
    },
    31: {
      is_pr: true,
      title: 'Draft PR',
      state: 'open',
      author: 'b',
      bot: false,
      updated_at: '2026-09-01T00:00:00Z',
      comments: 0,
      review_comments: 2,
      reactions: 1,
      comment_reactions: 0,
      last_comment: null,
      html_url: 'https://github.com/octo/alpha/pull/31',
      draft: true
    },
    29: {
      is_pr: true,
      title: 'Merged PR',
      state: 'merged',
      author: 'c',
      bot: true,
      updated_at: '2026-07-01T00:00:00Z',
      comments: 0,
      review_comments: 0,
      reactions: 0,
      comment_reactions: 0,
      last_comment: null,
      html_url: 'https://github.com/octo/alpha/pull/29',
      draft: false
    }
  },
  discussions: {
    5: {
      title: 'Open discussion',
      closed: false,
      author: 'd',
      category: 'Q&A',
      comments: 2,
      reactions: 0,
      comment_reactions: 0,
      updated_at: '2026-09-02T00:00:00Z',
      answered: true
    },
    4: {
      title: 'Closed discussion',
      closed: true,
      author: 'e',
      category: 'Ideas',
      comments: 0,
      reactions: 0,
      comment_reactions: 0,
      updated_at: '2026-08-02T00:00:00Z',
      answered: false
    }
  },
  releases: {
    1: {
      tag_name: '1.0.0',
      name: 'First',
      draft: false,
      prerelease: false,
      published_at: '2026-01-01T00:00:00Z'
    },
    2: {
      tag_name: '1.1.0',
      name: 'Second',
      draft: false,
      prerelease: false,
      published_at: '2026-06-01T00:00:00Z'
    }
  },
  alerts: {
    dependabot: {open: 100, truncated: true, by_severity: {high: 60, moderate: 40}},
    code_scanning: {unavailable: true}
  },
  ci: {
    name: 'Node.js CI',
    status: 'completed',
    conclusion: 'success',
    updated_at: '2026-09-07T05:32:01Z',
    html_url: 'https://github.com/octo/alpha/actions/runs/1'
  }
};

const STATE_DOC =
  '---\ntitle: alpha — state\ntype: state\n---\n\n## Baseline snapshot\n\nHEAD `abc1234` at 1.1.0.\n\n## GitHub\n\nAuto-maintained.\n\n' +
  fence(BASELINE) +
  '\n';

test('brief renders exactly what the CLI renders for a collected digest', t => {
  t.equal(briefText(brief(DIGEST)), EXPECTED_BRIEF);
});

test('brief model: weighted order, provenance, links', t => {
  const m = brief(DIGEST);
  t.deepEqual(
    m.moved.map(x => [x.name, x.weight, x.project]),
    [
      ['gamma', 0, 'gamma'],
      ['alpha', 1, 'alpha'],
      ['beta', 4, 'beta']
    ],
    'advisories first, then a human issue, then alerts and CI; project carried for the queue link'
  );
  t.equal(m.repos, 6);
  t.equal(m.quiet, 1, 'zeta is live and silent');
  t.deepEqual(m.errors, [{name: 'epsilon', message: 'HTTP 404'}]);
  t.equal(m.firstRuns.length, 1);
  t.equal(m.partial, 1);
  t.equal(m.stored, null, 'a collected digest has no stored-runs suffix');

  const alpha = m.moved[1];
  t.equal(
    alpha.phrases.length,
    3,
    'the own single comment (weight null) and the bot PR (counter) are not phrases'
  );
  t.deepEqual(
    alpha.phrases[0].find(p => typeof p !== 'string'),
    {text: '#30', href: 'https://github.com/octo/alpha/issues/30'},
    'item numbers link to the item'
  );
  const beta = m.moved[2];
  t.deepEqual(
    beta.phrases[0].find(p => typeof p !== 'string'),
    {text: 'Dependabot alerts', href: 'https://github.com/octo/beta/security/dependabot'},
    'alert counts link to the security tab'
  );
  t.deepEqual(
    beta.phrases[1].find(p => typeof p !== 'string'),
    {text: 'CI Node.js CI', href: 'https://github.com/octo/beta/actions/runs/1'}
  );
  const gamma = m.moved[0];
  t.equal(
    gamma.phrases[0].find(p => typeof p !== 'string').href,
    'https://github.com/octo/gamma/security/advisories/GHSA-xxxx-yyyy-zzzz'
  );
  t.equal(gamma.phrases[1].find(p => typeof p !== 'string').text, 'release 2.1.0');
  t.equal(phraseText(gamma.phrases[1]), 'release 2.1.0');
});

test('parseRuns reads the json fences newest first and skips prose-only sections', t => {
  const runs = parseRuns(DIGEST_DOC);
  t.deepEqual(
    runs.map(r => r.collected_at),
    ['2026-09-06T12:00:00.000Z', '2026-09-05T12:00:00.000Z']
  );
  t.deepEqual(parseRuns(''), []);
  t.deepEqual(parseRuns('## x\n\n```json\n{not json\n```\n'), [], 'a broken fence is skipped');
});

test('storedMovement merges the window oldest-first and sizes the fleet from the newest fleet run', t => {
  const runs = parseRuns(DIGEST_DOC);
  const cutoff = '2026-09-01T00:00:00.000Z';
  const {digest, runs: selected} = storedMovement(runs, {cutoff});
  t.equal(selected.length, 2);
  t.equal(digest.mode, 'fleet');
  t.equal(digest.gh_user, 'octo');
  t.equal(digest.collected_at, '2026-09-06T12:00:00.000Z');
  t.deepEqual(digest.stored, {runs: 2, since: cutoff, fleet_size: 2}, '3 repos - 1 first run');
  t.equal(digest.repos.length, 1, 'first-run and silent repos merge to nothing');
  t.deepEqual(
    digest.repos[0].events.map(e => e.kind),
    ['pr.state', 'issue.new'],
    'older run first'
  );
  t.equal(digest.repos[0].since, '2026-09-01T00:00:00.000Z', 'the earliest since wins');
  t.deepEqual(digest.totals, {repos: 2, events: 2});
  t.equal(
    briefText(brief(digest)),
    [
      'Fleet movement since 2026-09-01 00:00 — 2 repositories, 1 with movement (2 stored runs, newest 2026-09-06 12:00)',
      '- alpha: new issue #31 by someone "Crash on empty input"; PR #12 "Bump deps" open → closed',
      '- quiet: 1 repository'
    ].join('\n')
  );

  const late = storedMovement(runs, {cutoff: '2026-09-06T00:00:00.000Z'});
  t.equal(late.runs.length, 1);
  t.equal(late.digest.stored.fleet_size, null, 'no fleet run in the window');
  t.deepEqual(late.digest.totals, {repos: 1, events: 1}, 'falls back to the moved count');
  t.equal(brief(late.digest).quiet, 0);

  const all = storedMovement(runs);
  t.equal(all.runs.length, 2, 'no cutoff selects every run');
  t.equal(all.cutoff, null);

  const one = storedMovement(runs, {runs: 1, repo: 'octo/alpha'});
  t.equal(one.runs.length, 1);
  t.equal(one.digest.mode, 'repo');
  t.deepEqual(
    one.digest.repos[0].events.map(e => e.kind),
    ['issue.new']
  );
  t.deepEqual(storedMovement(runs, {repo: 'octo/nope'}).digest.repos, []);
});

test('parseBaseline finds the GitHub block', t => {
  t.deepEqual(parseBaseline(STATE_DOC), BASELINE);
  t.equal(parseBaseline('---\ntitle: x\n---\n\n## Baseline snapshot\n\nno github block\n'), null);
  t.equal(parseBaseline('\n## GitHub\n\n```json\n{broken\n```\n'), null);
  t.equal(parseBaseline('\n## GitHub\n\nno fence at all\n'), null);
});

test('baselineRow counts the standing state the way the CLI table does', t => {
  const r = baselineRow(BASELINE);
  t.equal(r.repo, 'octo/alpha');
  t.equal(r.html_url, 'https://github.com/octo/alpha');
  t.equal(r.issues, 1, 'open issues only');
  t.equal(r.prs, 1, 'merged PRs are not open');
  t.equal(r.hasDiscussions, true);
  t.equal(r.discussions, 1);
  t.deepEqual([r.stars, r.forks, r.watchers], [7, 1, 2]);
  t.equal(r.advisories, 2, 'published only');
  t.equal(r.noCve, 1);
  t.equal(alertText(r.dependabot), '≥100');
  t.equal(alertText(r.codeScanning), 'off');
  t.deepEqual(r.dependabot.by_severity, {high: 60, moderate: 40});
  t.deepEqual(r.ci, {
    name: 'Node.js CI',
    state: 'success',
    html_url: 'https://github.com/octo/alpha/actions/runs/1',
    updated_at: '2026-09-07T05:32:01Z'
  });
  t.equal(r.collected_at, '2026-09-07T16:44:44.721Z');

  const bare = baselineRow({repo: 'octo/empty'});
  t.deepEqual(
    [
      bare.issues,
      bare.prs,
      bare.discussions,
      bare.advisories,
      bare.stars,
      bare.ci,
      bare.dependabot
    ],
    [0, 0, 0, 0, null, null, null]
  );
  t.equal(
    bare.html_url,
    'https://github.com/octo/empty',
    'derived when the block predates html_url'
  );
});

test('baselineDetail orders the open lists newest first', t => {
  const d = baselineDetail(BASELINE);
  t.deepEqual(
    d.openItems.map(it => it.number),
    ['31', '30']
  );
  t.deepEqual(
    d.openDiscussions.map(x => x.number),
    ['5']
  );
  t.deepEqual(
    d.advisories.map(a => a.id),
    ['GHSA-bbbb', 'GHSA-aaaa', 'GHSA-cccc'],
    'published_at desc, the undated draft last'
  );
  t.equal(d.release.tag_name, '1.1.0', 'the latest release');
  t.equal(d.since, '2026-09-07T16:42:19.524Z');
  t.equal(d.firstRun, false);
  t.deepEqual(baselineDetail({}).openItems, []);
  t.equal(baselineDetail({}).release, null);
});

test('helpers match the CLI', t => {
  t.equal(short('2026-09-07T16:44:52.890Z'), '2026-09-07 16:44');
  t.equal(short(null), '');
  t.equal(clip('short', 10), 'short');
  t.equal(
    clip('Bump the npm-deps group across 1 directory with 3 updates', 50),
    'Bump the npm-deps group across 1 directory with…'
  );
  t.equal(plural(1, 'repository', 'repositories'), '1 repository');
  t.equal(plural(2, 'repository', 'repositories'), '2 repositories');
});

const WEEKLY = Array.from({length: 52}, (_, i) => (i < 44 ? 1000 : i < 48 ? 1500 : 2000));
const PACKAGES = {
  collected_at: '2026-09-14T01:20:00.000Z',
  graph: {fetched_at: '2026-09-14T00:45:00.000Z', orgs: ['octo']},
  packages: [
    {
      name: 'alpha',
      repo: 'octo/alpha',
      published: true,
      npm: {
        latest: '3.1.0',
        published_at: '2026-08-01T00:00:00.000Z',
        deprecated: false,
        versions: 12,
        week: {start: '2026-09-05', end: '2026-09-11', downloads: 2000},
        weekly: WEEKLY,
        publishes: [['2026-08-01', '3.1.0']],
        top_versions: [
          ['2.4.0', 1200],
          ['3.1.0', 500],
          ['3.0.0', 200],
          ['1.0.0', 60],
          ['0.9.1', 40]
        ],
        versions_total: 2000,
        by_major: {3: 700, 2: 1200, 1: 60, 0.9: 40},
        dependents: {
          source: 'deps.dev',
          direct: 12,
          by_version: {'3.1.0': [3, 4], '2.4.0': [9, 30]},
          history: [
            ['2026-09-01', 10],
            ['2026-09-08', 11],
            ['2026-09-14', 12]
          ]
        },
        total: {since: '2020-01-01', through: '2026-09-08', settled: 100000, downloads: 104000}
      },
      fleet: {
        repo: 'octo/alpha',
        level: 2,
        uses: [['beta', 'dev']],
        used_by: [],
        dependents_in_order: [],
        projects: {beta: 'beta'}
      }
    },
    {name: 'alpha-private', repo: 'octo/alpha', published: false, npm: null, fleet: null}
  ]
};

test('parsePackages finds the Packages block beside the GitHub one, or alone', t => {
  const both = STATE_DOC + '\n## Packages\n\nAuto-maintained.\n\n' + fence(PACKAGES) + '\n';
  t.deepEqual(parsePackages(both), PACKAGES);
  t.deepEqual(parseBaseline(both), BASELINE, 'the GitHub block still reads first');
  const alone = '---\ntitle: x\n---\n\n## Packages\n\n' + fence(PACKAGES) + '\n';
  t.deepEqual(parsePackages(alone), PACKAGES);
  t.equal(parseBaseline(alone), null);
  t.equal(parsePackages(STATE_DOC), null);
});

test('storedMovement leaves a packages-only run out of the fleet size', t => {
  const runs = parseRuns(DIGEST_DOC);
  const packagesRun = {
    ...run('2026-09-07T12:00:00.000Z', 'fleet', [], {repos: 40}),
    packages_only: true
  };
  const {digest} = storedMovement([packagesRun, ...runs], {cutoff: '2026-09-01T00:00:00.000Z'});
  t.equal(digest.stored.fleet_size, 2, 'sized from the GitHub fleet run, not the 40');
});

test('brief counts a packages-only project for its counters, never as a repository', t => {
  const m = brief(DIGEST);
  t.ok(
    m.counters.includes('dependents +2 (gamma +3, @others/eta -1)'),
    'dependents fold by package'
  );
  t.equal(m.quiet, 1, 'eta moved but is not a repository');
  t.notOk(
    m.moved.some(x => x.name === 'others/eta'),
    'a dependents change is a counter only'
  );
});

test('package readers derive the table columns', t => {
  const npm = PACKAGES.packages[0].npm;
  t.deepEqual(fourWeekChange(WEEKLY), {last: 8000, prev: 6000, ratio: 1 / 3, noisy: false});
  t.equal(fourWeekChange(WEEKLY.map(() => 100)).noisy, true, 'under the noise base');
  t.equal(fourWeekChange([1, 2, 3]), null, 'fewer than eight weeks');
  t.equal(latestMajorShare(npm), 0.35);
  t.equal(latestMajorShare({...npm, by_major: null}), null, 'no split read');
  t.notOk(wholeShare(0.35));
  t.ok(wholeShare(1));
  t.ok(wholeShare(2470757 / 2470758), 'one stray download on another major still reads 100%');
  t.notOk(wholeShare(0.994));
  t.notOk(wholeShare(null), 'no split read');

  t.deepEqual(latestVersionShare(npm), {share: 0.25, atMost: false});
  t.deepEqual(
    latestVersionShare({...npm, latest: '3.2.0'}),
    {share: 0.02, atMost: true},
    'outside a full top list: at most the last one listed'
  );
  t.deepEqual(
    latestVersionShare({...npm, latest: '3.2.0', top_versions: npm.top_versions.slice(0, 3)}),
    {share: 0, atMost: false},
    'outside a shorter list: no downloads'
  );
  t.equal(latestVersionShare({...npm, versions_total: null}), null, 'no split read');

  t.deepEqual(
    majorShares(npm).map(r => [r.label, r.share, r.latest]),
    [
      ['3.x', 0.35, true],
      ['2.x', 0.6, false],
      ['1.x', 0.03, false],
      ['1 other major', 0.02, false]
    ],
    'the latest major plus the two heaviest, newest first, the rest folded'
  );
  t.deepEqual(majorShares({}), []);

  const deps = npm.dependents;
  t.deepEqual(dependentsChange(deps, '2026-09-07T12:00:00.000Z'), {
    now: 12,
    delta: 2,
    since: '2026-09-01',
    partial: false
  });
  t.deepEqual(
    dependentsChange(deps, '2026-08-01T00:00:00.000Z'),
    {now: 12, delta: 2, since: '2026-09-01', partial: true},
    'tracking began after the cutoff'
  );
  t.deepEqual(
    dependentsChange(deps),
    {now: 12, delta: 2, since: '2026-09-01', partial: false},
    'no cutoff measures from the first point'
  );
  t.equal(dependentsChange(null), null);

  const ends = weekEnds(npm);
  t.equal(ends.length, 52);
  t.equal(ends[51], '2026-09-11');
  t.equal(ends[0], '2025-09-19');

  const rows = packageRows([
    {project: 'alpha', packages: PACKAGES},
    {project: 'beta', packages: null}
  ]);
  t.equal(rows.length, 1, 'published packages only');
  t.match(rows[0], {
    name: 'alpha',
    project: 'alpha',
    latest: '3.1.0',
    week: {downloads: 2000},
    latestMajorShare: 0.35,
    latestVersionShare: {share: 0.25, atMost: false},
    total: 104000,
    level: 2,
    collected_at: '2026-09-14T01:20:00.000Z'
  });
});

test('number and version helpers', t => {
  t.equal(compact(7379090), '7.38M');
  t.equal(compact(419018), '419K');
  t.equal(compact(1606), '1,606');
  t.equal(compact(20100000), '20.1M');
  t.equal(compact(1.2e9), '1.2B');
  t.equal(compact(undefined), '-');
  t.equal(percent(0.35), '35%');
  t.equal(percent(0.044), '4.4%');
  t.equal(percent(null), '-');
  t.equal(majorOf('2.4.0'), '2');
  t.equal(majorOf('0.9.1'), '0.9', 'below 1.0.0 the minor is the breaking part');
  t.ok(compareVersions('10.0.0', '9.9.9') > 0);
  t.ok(compareVersions('2.0.0-beta.1', '2.0.0-beta.2') < 0);
  t.equal(compareVersions('1.2.3', '1.2.3'), 0);
});

test('review fixes: section bounds, release order, unit rollover', t => {
  const orphan =
    '\n## GitHub\n\nhand-edited, no fence\n\n## Packages\n\n' + fence({packages: []}) + '\n';
  t.equal(parseBaseline(orphan), null, "a heading never reads the next section's block");
  t.deepEqual(parsePackages(orphan), {packages: []});
  t.ok(compareVersions('1.0.0', '1.0.0-beta.1') > 0, 'a release sorts above its prerelease');
  t.equal(compareVersions('1.2.3+build.5', '1.2.3'), 0, 'build metadata is ignored');
  t.ok(compareVersions('2.0.0-rc.1', '1.9.9') > 0);
  t.equal(compact(999_500), '1M', 'the unit follows the rounded value');
  t.equal(compact(999_999_999), '1B');
  t.equal(compact(10_000), '10K');
});

test('repoGlance lists the open state and marks activity since the cutoff', t => {
  const g = repoGlance(BASELINE, '2026-08-15T00:00:00.000Z');
  t.deepEqual(
    g.issues.map(it => [it.number, it.active]),
    [[30, false]],
    'updated before the cutoff'
  );
  t.deepEqual(
    g.prs.map(it => [it.number, it.draft, it.active]),
    [[31, true, true]],
    'a merged PR is not open'
  );
  t.deepEqual(
    g.discussions.map(d => [d.number, d.active]),
    [[5, true]],
    'closed discussions drop'
  );
  t.deepEqual(
    g.advisories.map(a => [a.id, a.noCve, a.pending]),
    [
      ['GHSA-cccc', false, true],
      ['GHSA-bbbb', true, false],
      ['GHSA-aaaa', false, false]
    ],
    'the undated draft first, then newest published'
  );
  t.deepEqual(g.alerts.dependabot, {
    open: 100,
    truncated: true,
    severities: ['60 high', '40 moderate']
  });
  t.equal(g.alerts.codeScanning, null, 'an unavailable feature is not an alert');
  t.equal(g.ciFailing, false);
  t.equal(g.attention, true);
  t.equal(repoGlance(BASELINE).prs[0].active, false, 'no cutoff marks nothing');

  const quiet = {
    repo: 'octo/quiet',
    items: {7: {is_pr: false, state: 'closed', updated_at: '2026-09-01T00:00:00Z'}},
    advisories: {'GHSA-dddd': {state: 'published', cve_id: 'CVE-2026-2'}},
    ci: {name: 'CI', conclusion: 'success'}
  };
  t.equal(
    repoGlance(quiet).attention,
    false,
    'closed items and a CVE-backed advisory need nothing'
  );
  t.equal(
    repoGlance({...quiet, ci: {name: 'CI', conclusion: 'failure'}}).attention,
    true,
    'a failing CI does'
  );
});

test('packageMovement reports publishes and dependents changes in the window', t => {
  t.deepEqual(
    packageMovement(PACKAGES, '2026-07-30T00:00:00.000Z'),
    [{name: 'alpha', publishes: [['2026-08-01', '3.1.0']], dependents: null, deprecated: false}],
    'tracking began after the cutoff, so no dependents change is claimed'
  );
  t.deepEqual(packageMovement(PACKAGES, '2026-09-07T12:00:00.000Z'), [
    {
      name: 'alpha',
      publishes: [],
      dependents: {now: 12, delta: 2, since: '2026-09-01', partial: false},
      deprecated: false
    }
  ]);
  t.deepEqual(packageMovement(PACKAGES, '2026-09-20T00:00:00.000Z'), [], 'nothing since');
  t.deepEqual(packageMovement(PACKAGES, null), [], 'no window, no movement');
  t.deepEqual(packageMovement(null, '2026-09-01T00:00:00.000Z'), []);
});

test('repoGlance marks new items from people that the account has not answered', t => {
  const now = Date.parse('2026-09-14T00:00:00Z');
  const recent = '2026-09-10T00:00:00Z',
    old = '2026-08-01T00:00:00Z';
  const issue = (author, extra = {}) => ({
    is_pr: false,
    state: 'open',
    author,
    created_at: recent,
    ...extra
  });
  const b = {
    repo: 'octo/fresh',
    gh_user: 'octo',
    items: {
      1: issue('alice'),
      2: issue('alice', {owner_reacted: true}),
      3: issue('alice', {owner_commented: true}),
      4: issue('alice', {assignees: ['octo']}),
      5: {...issue('dependabot[bot]'), is_pr: true, bot: true},
      6: issue('octo'),
      7: issue('alice', {created_at: old}),
      8: issue('bob', {last_comment: {author: 'octo', at: recent}}),
      9: issue('bob', {reactions: 3, owner_reacted: false})
    },
    discussions: {
      10: {closed: false, author: 'carol', created_at: recent, owner_commented: false},
      11: {closed: false, author: 'carol', created_at: recent, owner_commented: true}
    }
  };
  const g = repoGlance(b, null, {now});
  t.deepEqual(
    [...g.issues, ...g.prs, ...g.discussions]
      .filter(x => x.fresh)
      .map(x => x.number)
      .sort((x, y) => x - y),
    [1, 9, 10],
    'answered by a reaction, a comment, or an assignee; bots, own items, and old items never count'
  );
  t.equal(g.freshCount, 3);
  t.equal(g.owner, 'octo');
  t.equal(repoGlance(b, null, {now, newDays: 3}).freshCount, 0, 'a shorter window');
  t.ok(
    answered({last_comment: {author: 'octo'}}, 'octo'),
    'an older baseline: the last comment stands in'
  );
  t.notOk(answered({reactions: 3}, 'octo'), "someone else's reaction is not an answer");
});
