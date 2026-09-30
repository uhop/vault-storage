// Markup shared by the fleet pages: links, the GitHub baseline detail, and the
// stale mark. The data readers live in fleet-digest.js.

import {esc} from './api.js';
import {
  stateDocPath,
  storedMovement,
  brief,
  baselineRow,
  baselineDetail,
  alertText,
  plural,
  short
} from './fleet-digest.js';

// A baseline older than `show --fleet`'s default window is marked stale.
export const STALE_MS = 7 * 864e5;
export const isStale = iso => Boolean(iso) && Date.now() - Date.parse(iso) > STALE_MS;

export const WINDOW_KEY = 'vault.fleet.window';
export const WINDOWS = [
  ['1d', '24 hours'],
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['90d', '90 days'],
  ['all', 'all stored runs']
];
export const windowState = () => {
  const w = localStorage.getItem(WINDOW_KEY);
  return WINDOWS.some(([v]) => v === w) ? w : '7d';
};

export const ext = (href, text, cls = '') =>
  `<a${cls ? ` class="${cls}"` : ''} href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
export const renderParts = parts =>
  parts.map(p => (typeof p === 'string' ? esc(p) : ext(p.href, p.text))).join('');
export const noteHref = path => `/ui/note.html?path=${encodeURIComponent(path)}`;
export const queueHref = project => noteHref(`projects/${project}/queue.md`);
export const projectHref = (project, anchor = '') =>
  `/ui/fleet-project.html?project=${encodeURIComponent(project)}${anchor ? `#${encodeURIComponent(anchor)}` : ''}`;
export const npmHref = name => `https://www.npmjs.com/package/${name}`;

export const repoLinks = (htmlUrl, hasDiscussions) =>
  [
    ['issues', 'Issues'],
    ['pulls', 'Pull requests'],
    ['actions', 'Actions'],
    ...(hasDiscussions ? [['discussions', 'Discussions']] : []),
    ['projects', 'Projects'],
    ['security', 'Security']
  ]
    .map(([path, text]) => ext(`${htmlUrl}/${path}`, text))
    .join(' · ');

// The `source:` of a GitHub thread's item, spelled as `fleet-status.mjs file --source`
// spells it: the server keys the upsert (D107) and the thread state (D111) on it.
export const threadSource = (repo, kind, key) =>
  kind === 'discussion'
    ? `github ${repo} discussion#${key}`
    : kind === 'advisory'
      ? `github ${repo} ${key}`
      : `github ${repo}#${key}`;

export const closedUpstream = upstream => upstream === 'closed' || upstream === 'merged';

export const advisoryOpen = a =>
  a.state === 'triage' || a.state === 'draft' || (a.state === 'published' && !a.cve_id);

// The bold title `fleet-status.mjs file` gives a review item. A `**` run in a
// thread title would close the bold early, and a newline would end the item.
export const trackHeading = (repo, kind, key, title) => {
  const t = String(title ?? '')
    .replace(/\*{2,}/g, '*')
    .replace(/\s+/g, ' ')
    .trim();
  const thread =
    kind === 'discussion'
      ? `GitHub: ${repo} discussion #${key}`
      : kind === 'advisory'
        ? `GitHub: ${repo} ${key}`
        : `GitHub: ${repo}#${key}`;
  const head = t ? `${thread} — ${t}` : thread;
  return /[.!?]$/.test(head) ? head : `${head}.`;
};

export const trackItem = ({heading, source, url, date}) =>
  `- **${heading}** Tracked from the project page on ${date}${url ? `: ${url}` : '.'}\n  - source: ${source}`;

export const closedTrail = (date, upstream) =>
  `**Closed ${date}**: the thread closed upstream (${upstream}).`;

export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The notes that mention one outside object (D112), from a `GET /links` entry.
export const mentionsList = entry => {
  const mentions = entry?.mentions ?? [];
  if (mentions.length === 0) return '';
  const items = mentions
    .map(
      m =>
        `<li><a href="${noteHref(m.file_path)}">${esc(m.title ?? m.file_path)}</a>${
          m.queue_items.length ? ` · ${m.queue_items.map(q => esc(q.title)).join('; ')}` : ''
        }</li>`
    )
    .join('');
  return `<details class="mentions"><summary>${esc(plural(mentions.length, 'note'))}</summary><ul>${items}</ul></details>`;
};

// The stored GitHub baseline of one project and its movement in the window;
// `tracked` and `track` add the queue marks and the Track offer (D111), and
// `mentions`, a map from a lowercased key, the notes that mention a thread (D112).
export const githubDetail = (
  {project, baseline: b},
  runs,
  cutoff,
  {tracked = null, track = false, mentions = null} = {}
) => {
  const r = baselineRow(b),
    d = baselineDetail(b);
  const {digest} = storedMovement(runs, {cutoff, repo: r.repo});
  const byKey = new Map((tracked ?? []).map(x => [x.source.toLowerCase(), x]));
  const mark = (kind, key, title, url, offer = true) => {
    const source = threadSource(r.repo, kind, key);
    const noted = mentionsList(mentions?.get(source.toLowerCase()));
    if (!tracked) return noted;
    const item = byKey.get(source.toLowerCase());
    if (item)
      return ` · on the queue: <a href="${queueHref(project)}">${esc(item.title)}</a> <span class="fmw-pill">${esc(item.section)}</span>${noted}`;
    return track && offer
      ? ` <button type="button" class="fmw-pill" data-track="${esc(source)}" data-heading="${esc(trackHeading(r.repo, kind, key, title))}" data-url="${esc(url ?? '')}">Track</button>${noted}`
      : noted;
  };
  const lines = [
    `${esc(plural(r.stars ?? 0, 'star'))}, ${esc(plural(r.forks ?? 0, 'fork'))}, ${esc(plural(r.watchers ?? 0, 'watcher'))}; ${esc(plural(r.issues, 'open issue'))}, ${esc(plural(r.prs, 'open PR'))}${r.hasDiscussions ? `, ${esc(plural(r.discussions, 'open discussion'))}` : ''}; CI ${
      r.ci
        ? `${r.ci.html_url ? ext(r.ci.html_url, r.ci.state) : esc(r.ci.state)} (${esc(r.ci.name)}, ${esc(short(r.ci.updated_at))})`
        : 'none'
    }`,
    `alerts: dependabot ${esc(alertText(r.dependabot))}, code scanning ${esc(alertText(r.codeScanning))}; collected ${esc(short(r.collected_at))}${d.firstRun ? ' (first run)' : ''}`
  ];
  const sections = [];
  if (d.advisories.length)
    sections.push(
      `<div>advisories (${d.advisories.length}):</div><ul>${d.advisories
        .map(
          a =>
            `<li>${a.html_url ? ext(a.html_url, a.id) : `<code>${esc(a.id)}</code>`} ${esc(a.state)} ${esc(a.severity ?? '-')} ${esc(a.cve_id ?? 'no CVE')} ${esc(short(a.published_at))} ${esc(a.summary ?? '')}${mark('advisory', a.id, a.summary, a.html_url, advisoryOpen(a))}</li>`
        )
        .join('')}</ul>`
    );
  if (d.openItems.length)
    sections.push(
      `<div>open items (${d.openItems.length}):</div><ul>${d.openItems
        .map(
          it =>
            `<li>${it.is_pr ? 'PR' : 'issue'} ${it.html_url ? ext(it.html_url, `#${it.number}`) : `#${esc(it.number)}`} ${esc(it.title)} — ${esc(it.author)}${it.bot ? ' (bot)' : ''}, ${esc(plural((it.comments ?? 0) + (it.review_comments ?? 0), 'comment'))}, ${esc(plural((it.reactions ?? 0) + (it.comment_reactions ?? 0), 'reaction'))}${it.last_comment ? `, last comment ${esc(it.last_comment.author)} ${esc(short(it.last_comment.at))}` : ''}${it.draft ? ', draft' : ''}${mark('item', it.number, it.title, it.html_url)}</li>`
        )
        .join('')}</ul>`
    );
  if (d.openDiscussions.length)
    sections.push(
      `<div>open discussions (${d.openDiscussions.length}):</div><ul>${d.openDiscussions
        .map(
          x =>
            `<li>${x.url ? ext(x.url, `#${x.number}`) : `#${esc(x.number)}`} ${esc(x.title)} — ${esc(x.author)}, ${esc(x.category ?? '-')}, ${esc(plural(x.comments ?? 0, 'comment'))}, ${esc(plural((x.reactions ?? 0) + (x.comment_reactions ?? 0), 'reaction'))}${x.last_comment ? `, last comment ${esc(x.last_comment.author)} ${esc(short(x.last_comment.at))}` : ''}${x.answered ? ', answered' : ''}${mark('discussion', x.number, x.title, x.url)}</li>`
        )
        .join('')}</ul>`
    );
  if (d.release)
    sections.push(
      `<div>latest release: ${d.release.html_url ? ext(d.release.html_url, d.release.tag_name) : esc(d.release.tag_name)}${d.release.name ? ` — ${esc(d.release.name)}` : ''}${d.release.draft ? ' (draft)' : ''}${d.release.prerelease ? ' (prerelease)' : ''} ${esc(short(d.release.published_at))}</div>`
    );
  const m = digest.repos.length ? brief(digest) : null;
  const changes = [];
  if (m?.moved.length) changes.push(...m.moved[0].phrases.map(p => `<li>${renderParts(p)}</li>`));
  if (m?.counters.length) changes.push(`<li>counters: ${esc(m.counters.join('; '))}</li>`);
  sections.push(
    changes.length
      ? `<div>changes since ${esc(m.stamp)} (${esc(plural(digest.totals.events, 'event'))}):</div><ul>${changes.join('')}</ul>`
      : `<div>changes${cutoff ? ` since ${esc(short(cutoff))}` : ''}: none stored</div>`
  );
  return {
    html: `${lines.map(l => `<div>${l}</div>`).join('')}${sections.join('')}`,
    links: `${r.html_url ? `${ext(r.html_url, 'GitHub')} · ${repoLinks(r.html_url, r.hasDiscussions)} · ` : ''}<a href="${queueHref(project)}">queue</a> · <a href="${noteHref(stateDocPath(project))}">state.md</a>`
  };
};
