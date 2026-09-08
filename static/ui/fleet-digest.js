// Client-side port of the stored-run readers and the brief/table renderers in
// claude-config's `skills/fleet-status/fleet-status.mjs` (§ Brief, § Stored
// runs). The page reads the documents that script writes, so the two must agree
// line for line; briefText() exists so a test can hold them to it.

export const DIGEST_PATH = 'projects/agent-workflow/fleet-status.md';
export const stateDocPath = project => `projects/${project}/state.md`;
const GITHUB_HEADING = '## GitHub';

export const short = iso => (iso ?? '').replace(/T(\d\d:\d\d).*$/, ' $1');
export const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;
export const clip = (text, n) => {
  if (!text || text.length <= n) return text;
  const cut = text.slice(0, n - 1),
    at = cut.lastIndexOf(' ');
  return `${(at > n / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
};
const byDesc = key => (a, b) => (key(b) ?? '').localeCompare(key(a) ?? '');

// ─── Stored documents ────────────────────────────────────────────────────────

export const parseRuns = text => {
  const runs = [];
  for (const section of text.split(/\n(?=## )/)) {
    const m = /```json\n([\s\S]*?)\n```/.exec(section);
    if (!m) continue;
    try {
      runs.push(JSON.parse(m[1]));
    } catch {}
  }
  return runs.sort(byDesc(r => r.collected_at));
};

export const parseBaseline = text => {
  const at = text.indexOf(`\n${GITHUB_HEADING}\n`);
  if (at < 0) return null;
  const m = /```json\n([\s\S]*?)\n```/.exec(text.slice(at));
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
};

export const parseWhen = text => {
  const m = /^(\d+)d$/.exec(text);
  if (m) return new Date(Date.now() - Number(m[1]) * 864e5).toISOString();
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

export const storedMovement = (all, {cutoff = null, runs: count = null, repo = null} = {}) => {
  const runs = count
    ? all.filter(r => !repo || r.repos?.some(x => x.repo === repo)).slice(0, count)
    : cutoff
      ? all.filter(r => r.collected_at >= cutoff)
      : all;
  const byRepo = new Map();
  let fleetSize = null;
  for (const run of [...runs].reverse()) {
    if (run.mode === 'fleet' && run.totals?.repos)
      fleetSize = run.totals.repos - (run.totals.first_run ?? 0) - (run.totals.errors ?? 0);
    for (const r of run.repos ?? []) {
      if (repo && r.repo !== repo) continue;
      if (r.error || r.first_run || r.skipped || !r.events?.length) continue;
      const cur = byRepo.get(r.repo) ?? {
        repo: r.repo,
        project: r.project,
        first_run: false,
        since: r.since ?? null,
        events: [],
        errors: []
      };
      if (r.since && (!cur.since || r.since < cur.since)) cur.since = r.since;
      cur.events.push(...r.events);
      byRepo.set(r.repo, cur);
    }
  }
  const repos = [...byRepo.values()].map(r => ({...r, summary: {events: r.events.length}}));
  return {
    runs,
    cutoff,
    digest: {
      collected_at: runs[0]?.collected_at ?? null,
      mode: repo ? 'repo' : 'fleet',
      gh_user: runs[0]?.gh_user ?? null,
      stored: {runs: runs.length, since: cutoff, fleet_size: fleetSize},
      repos,
      totals: {
        repos: fleetSize ?? repos.length,
        events: repos.reduce((n, r) => n + r.events.length, 0)
      }
    }
  };
};

// ─── Brief ───────────────────────────────────────────────────────────────────
// A phrase is an array of parts: plain strings and {text, href} links, so the
// page can render anchors and a test can compare the joined text with the CLI.

const shortRepo = (repo, ghUser) =>
  ghUser && repo.startsWith(`${ghUser}/`) ? repo.slice(ghUser.length + 1) : repo;
const signed = n => (n > 0 ? `+${n}` : String(n));
const itemWord = kind =>
  kind.startsWith('pr.') ? 'PR' : kind.startsWith('discussion.') ? 'discussion' : 'issue';
const isItemKind = kind => /^(issue|pr|discussion)\./.test(kind);
const link = (text, href) => (href ? {text, href} : text);
const quoteExcerpt = (text, n) => (text ? `: "${clip(text, n)}"` : '');

export const briefWeight = (e, ghUser) => {
  const k = e.kind;
  if (k.startsWith('advisory.')) return 0;
  if (isItemKind(k)) {
    if (k.endsWith('.new')) return e.bot ? 'counter' : 1;
    if (k.endsWith('.comments'))
      return e.last_comment?.author && e.last_comment.author === ghUser && e.delta === 1 ? null : 2;
    if (k.endsWith('.state')) return 3;
    if (k.endsWith('.updated')) return e.note ? 2 : null;
    return 'counter';
  }
  if (k.startsWith('release.') || k === 'ci.conclusion') return 4;
  if (k.startsWith('alerts.')) return e.to > e.from ? 4 : 'counter';
  return 'counter';
};

export const eventLine = e => {
  const who = e.author ? ` by ${e.author}${e.bot ? ' (bot)' : ''}` : '';
  switch (true) {
    case e.kind.startsWith('advisory.'):
      return `${e.kind} ${e.id}${e.cve_id ? ` ${e.cve_id}` : ''}${e.from ? ` ${e.from} → ${e.to}` : ''} — ${e.summary}`;
    case isItemKind(e.kind): {
      const detail = e.kind.endsWith('.state')
        ? `${e.from} → ${e.to}`
        : e.kind.endsWith('.comments')
          ? `+${e.delta} comment${e.delta === 1 ? '' : 's'}${e.last_comment ? `, last ${e.last_comment.author}${e.last_comment.excerpt ? `: "${e.last_comment.excerpt}"` : ''}` : ''}`
          : e.kind.endsWith('.reactions')
            ? `${e.delta > 0 ? '+' : ''}${e.delta} reaction${Math.abs(e.delta) === 1 ? '' : 's'}`
            : (e.note ?? '');
      return `${e.kind} #${e.number}${who} — ${e.title}${detail ? ` (${detail})` : ''}${e.excerpt ? ` — ${e.excerpt}` : ''}`;
    }
    case e.kind === 'fork.new' || e.kind === 'fork.removed':
      return `${e.kind} ${e.login} (${e.full_name})`;
    case /^(star|watcher)\.(new|removed)$/.test(e.kind):
      return `${e.kind} ${e.login}`;
    case /count$/.test(e.kind):
      return `${e.kind} ${e.from} → ${e.to}`;
    case e.kind.startsWith('release.'):
      return `${e.kind} ${e.tag}${e.name ? ` — ${e.name}` : ''}`;
    case e.kind.startsWith('alerts.'):
      return `${e.kind} ${e.from} → ${e.to} open`;
    case e.kind === 'ci.conclusion':
      return `ci ${e.name}: ${e.from} → ${e.to}`;
    default:
      return `${e.kind} ${JSON.stringify(e)}`;
  }
};

export const briefPhrase = e => {
  const k = e.kind,
    url = e.html_url ?? e.url ?? null;
  if (k === 'advisory.new')
    return [
      link(`advisory ${e.id}`, url),
      ` (${e.state}${e.severity ? `, ${e.severity}` : ''}${e.cve_id ? `, ${e.cve_id}` : ''}) "${e.summary}"`
    ];
  if (k === 'advisory.cve_assigned') return [link(`advisory ${e.id}`, url), ` got ${e.cve_id}`];
  if (k === 'advisory.state') return [link(`advisory ${e.id}`, url), ` ${e.from} → ${e.to}`];
  if (k === 'advisory.updated') return [link(`advisory ${e.id}`, url), ' updated'];
  if (k === 'release.new')
    return [
      link(`release ${e.tag}`, url),
      `${e.draft ? ' (draft)' : ''}${e.prerelease ? ' (prerelease)' : ''}`
    ];
  if (k === 'release.published') return [link(`release ${e.tag}`, url), ' published'];
  if (k === 'ci.conclusion') return [link(`CI ${e.name}`, url), `: ${e.from} → ${e.to}`];
  if (k.startsWith('alerts.')) {
    const dependabot = k === 'alerts.dependabot';
    return [
      link(
        `${dependabot ? 'Dependabot' : 'code scanning'} alerts`,
        e.repo &&
          `https://github.com/${e.repo}/security/${dependabot ? 'dependabot' : 'code-scanning'}`
      ),
      ` ${e.from} → ${e.to}`
    ];
  }
  if (!isItemKind(k)) return [eventLine(e)];
  const ref = link(`#${e.number}`, url);
  if (k.endsWith('.new'))
    return [
      `new ${itemWord(k)} `,
      ref,
      ` by ${e.author} "${e.title}"${e.excerpt ? ` — ${clip(e.excerpt, 80)}` : ''}`
    ];
  if (k.endsWith('.comments')) {
    const lc = e.last_comment;
    return [
      `${itemWord(k)} `,
      ref,
      ` "${clip(e.title, 50)}" +${plural(e.delta, 'comment')}${lc ? ` by ${lc.author}${quoteExcerpt(lc.excerpt, 80)}` : ''}`
    ];
  }
  if (k.endsWith('.state'))
    return [`${itemWord(k)} `, ref, ` "${clip(e.title, 50)}" ${e.from} → ${e.to}`];
  if (k.endsWith('.updated'))
    return [
      `${itemWord(k)} `,
      ref,
      ` "${clip(e.title, 50)}" active, not in the baseline (${plural(e.comments ?? 0, 'comment')}${e.last_comment ? `, last by ${e.last_comment.author}${quoteExcerpt(e.last_comment.excerpt, 80)}` : ''})`
    ];
  return [eventLine(e)];
};

export const phraseText = parts => parts.map(p => (typeof p === 'string' ? p : p.text)).join('');

const briefCounters = (repos, ghUser) => {
  const stars = new Map(),
    forks = new Map(),
    forkLogins = new Map(),
    watchers = new Map(),
    watcherLogins = new Map(),
    reactions = new Map(),
    bots = [],
    alertsDown = [];
  const add = (m, key, n) => m.set(key, (m.get(key) ?? 0) + n);
  const name_ = (m, key, login) => m.set(key, [...(m.get(key) ?? []), login]);
  for (const r of repos) {
    const name = shortRepo(r.repo, ghUser);
    for (const e of r.events) {
      const k = e.kind;
      if (k === 'stars.count') add(stars, name, e.delta ?? e.to - e.from);
      else if (k === 'star.new') add(stars, name, 1);
      else if (k === 'star.removed') add(stars, name, -1);
      else if (k === 'fork.new') {
        add(forks, name, 1);
        name_(forkLogins, name, e.login);
      } else if (k === 'fork.removed') add(forks, name, -1);
      else if (k === 'forks.count') add(forks, name, e.to - e.from);
      else if (k === 'watcher.new') {
        add(watchers, name, 1);
        name_(watcherLogins, name, e.login);
      } else if (k === 'watcher.removed') add(watchers, name, -1);
      else if (k === 'watchers.count') add(watchers, name, e.to - e.from);
      else if (isItemKind(k) && k.endsWith('.reactions'))
        add(reactions, `${name}#${e.number}`, e.delta);
      else if (isItemKind(k) && k.endsWith('.new') && e.bot)
        bots.push(`${itemWord(k)} ${name}#${e.number} by ${e.author}`);
      else if (k.startsWith('alerts.') && e.to < e.from)
        alertsDown.push(`${name} ${k.slice(7).replace('_', ' ')} ${e.from} → ${e.to}`);
    }
  }
  const total = m => [...m.values()].reduce((a, b) => a + b, 0);
  const list = (m, fmt) => [...m].map(fmt).join(', ');
  const parts = [];
  if (stars.size)
    parts.push(`stars ${signed(total(stars))} (${list(stars, ([k, v]) => `${k} ${signed(v)}`)})`);
  if (forks.size)
    parts.push(
      `forks ${signed(total(forks))} (${list(forks, ([k, v]) => `${k} ${signed(v)}${forkLogins.has(k) ? `: ${forkLogins.get(k).join(', ')}` : ''}`)})`
    );
  if (watchers.size)
    parts.push(
      `watchers ${signed(total(watchers))} (${list(watchers, ([k, v]) => `${k} ${signed(v)}${watcherLogins.has(k) ? `: ${watcherLogins.get(k).join(', ')}` : ''}`)})`
    );
  if (reactions.size)
    parts.push(
      `reactions ${signed(total(reactions))} (${list(reactions, ([k, v]) => `${k} ${signed(v)}`)})`
    );
  if (bots.length) parts.push(`bots: ${bots.join(', ')}`);
  if (alertsDown.length) parts.push(`alerts down (${alertsDown.join('; ')})`);
  return parts;
};

export const brief = digest => {
  const ghUser = digest.gh_user ?? null;
  const fleet = digest.mode === 'fleet';
  const live = digest.repos.filter(r => !r.error && !r.first_run && !r.skipped);
  const moved = [];
  let active = 0;
  for (const r of live) {
    const weighted = r.events.map(e => ({w: briefWeight(e, ghUser), e})).filter(x => x.w !== null);
    if (weighted.length) ++active;
    const lead = weighted.filter(x => typeof x.w === 'number').sort((a, b) => a.w - b.w);
    if (lead.length)
      moved.push({
        name: shortRepo(r.repo, ghUser),
        repo: r.repo,
        project: r.project ?? null,
        weight: lead[0].w,
        phrases: lead.map(x => briefPhrase(x.e))
      });
  }
  moved.sort((a, b) => a.weight - b.weight || a.name.localeCompare(b.name));
  const sinces = live
    .map(r => r.since ?? r.snapshot?.window?.since)
    .filter(Boolean)
    .sort();
  const since = digest.stored?.since ?? sinces[0] ?? null;
  const firstRuns = digest.repos
    .filter(r => r.first_run)
    .map(r => ({name: shortRepo(r.repo, ghUser), summary: r.summary}));
  const errors = digest.repos
    .filter(r => r.error)
    .map(r => ({name: shortRepo(r.repo, ghUser), message: r.error.message}));
  const partial = live.reduce((n, r) => n + (r.errors?.length ?? 0), 0);
  const fleetSize = digest.stored ? digest.stored.fleet_size : live.length;
  return {
    fleet,
    since,
    stamp: since ? short(since) : 'the baseline',
    repos: digest.totals?.repos ?? digest.repos.length,
    names: digest.repos.map(r => shortRepo(r.repo, ghUser)),
    stored: digest.stored ? {runs: digest.stored.runs, newest: digest.collected_at} : null,
    moved,
    counters: briefCounters(live, ghUser),
    firstRuns,
    errors,
    partial,
    quiet: fleet && fleetSize !== null ? fleetSize - active : 0
  };
};

export const briefText = (m, {header = true} = {}) => {
  const lines = [];
  const stored = m.stored
    ? ` (${plural(m.stored.runs, 'stored run')}, newest ${short(m.stored.newest)})`
    : '';
  if (header)
    lines.push(
      m.fleet
        ? `Fleet movement since ${m.stamp} — ${plural(m.repos, 'repository', 'repositories')}, ${m.moved.length} with movement${stored}`
        : `${m.names.join(', ')} — movement since ${m.stamp}${stored}`
    );
  for (const x of m.moved) lines.push(`- ${x.name}: ${x.phrases.map(phraseText).join('; ')}`);
  if (m.counters.length) lines.push(`- counters: ${m.counters.join('; ')}`);
  if (m.firstRuns.length) {
    const s = m.firstRuns[0].summary;
    lines.push(
      m.fleet
        ? `- first run: ${plural(m.firstRuns.length, 'repository', 'repositories')} (baseline recorded)`
        : `- first run — baseline recorded (${plural(s.open_items, 'open item')}, ${plural(s.stars, 'star')}, ${plural(s.forks, 'fork')}${s.advisories_without_cve ? `, ${s.advisories_without_cve} published advisories without a CVE` : ''})`
    );
  }
  if (m.errors.length)
    lines.push(`- errors: ${m.errors.map(e => `${e.name}: ${e.message}`).join('; ')}`);
  if (m.partial) lines.push(`- partial errors: ${m.partial} (details in the collected JSON)`);
  if (m.quiet > 0) lines.push(`- quiet: ${plural(m.quiet, 'repository', 'repositories')}`);
  if (lines.length === (header ? 1 : 0)) lines.push('- none');
  return lines.join('\n');
};

// ─── Baselines ───────────────────────────────────────────────────────────────

const alertOf = a =>
  !a || a.unavailable
    ? null
    : {open: a.open, truncated: Boolean(a.truncated), by_severity: a.by_severity ?? {}};
export const alertText = a => (a ? `${a.open}${a.truncated ? '+' : ''}` : 'off');

export const baselineRow = b => {
  const open = Object.values(b.items ?? {}).filter(i => i.state === 'open');
  const issues = open.filter(i => !i.is_pr).length;
  const published = Object.values(b.advisories ?? {}).filter(a => a.state === 'published');
  return {
    repo: b.repo ?? null,
    html_url: b.html_url ?? (b.repo ? `https://github.com/${b.repo}` : null),
    issues,
    prs: open.length - issues,
    hasDiscussions: Boolean(b.meta?.has_discussions),
    discussions: Object.values(b.discussions ?? {}).filter(d => !d.closed).length,
    stars: b.meta?.stars ?? null,
    forks: b.meta?.forks ?? null,
    watchers: b.meta?.watchers ?? null,
    advisories: published.length,
    noCve: published.filter(a => !a.cve_id).length,
    dependabot: alertOf(b.alerts?.dependabot),
    codeScanning: alertOf(b.alerts?.code_scanning),
    ci: b.ci
      ? {
          name: b.ci.name,
          state: b.ci.conclusion ?? b.ci.status,
          html_url: b.ci.html_url ?? null,
          updated_at: b.ci.updated_at ?? null
        }
      : null,
    collected_at: b.collected_at ?? null
  };
};

export const baselineDetail = b => ({
  openItems: Object.entries(b.items ?? {})
    .filter(([, it]) => it.state === 'open')
    .sort(byDesc(([, it]) => it.updated_at))
    .map(([number, it]) => ({number, ...it})),
  openDiscussions: Object.entries(b.discussions ?? {})
    .filter(([, d]) => !d.closed)
    .sort(byDesc(([, d]) => d.updated_at))
    .map(([number, d]) => ({number, ...d})),
  advisories: Object.entries(b.advisories ?? {})
    .sort(byDesc(([, a]) => a.published_at))
    .map(([id, a]) => ({id, ...a})),
  release: Object.values(b.releases ?? {}).sort(byDesc(r => r.published_at))[0] ?? null,
  since: b.window?.since ?? null,
  firstRun: Boolean(b.window?.first_run)
});
