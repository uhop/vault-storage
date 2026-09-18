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
} from '/ui/fleet-digest.js';

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

// The stored GitHub baseline of one project and its movement in the window.
export const githubDetail = ({project, baseline: b}, runs, cutoff) => {
  const r = baselineRow(b),
    d = baselineDetail(b);
  const {digest} = storedMovement(runs, {cutoff, repo: r.repo});
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
            `<li>${a.html_url ? ext(a.html_url, a.id) : `<code>${esc(a.id)}</code>`} ${esc(a.state)} ${esc(a.severity ?? '-')} ${esc(a.cve_id ?? 'no CVE')} ${esc(short(a.published_at))} ${esc(a.summary ?? '')}</li>`
        )
        .join('')}</ul>`
    );
  if (d.openItems.length)
    sections.push(
      `<div>open items (${d.openItems.length}):</div><ul>${d.openItems
        .map(
          it =>
            `<li>${it.is_pr ? 'PR' : 'issue'} ${it.html_url ? ext(it.html_url, `#${it.number}`) : `#${esc(it.number)}`} ${esc(it.title)} — ${esc(it.author)}${it.bot ? ' (bot)' : ''}, ${esc(plural((it.comments ?? 0) + (it.review_comments ?? 0), 'comment'))}, ${esc(plural((it.reactions ?? 0) + (it.comment_reactions ?? 0), 'reaction'))}${it.last_comment ? `, last comment ${esc(it.last_comment.author)} ${esc(short(it.last_comment.at))}` : ''}${it.draft ? ', draft' : ''}</li>`
        )
        .join('')}</ul>`
    );
  if (d.openDiscussions.length)
    sections.push(
      `<div>open discussions (${d.openDiscussions.length}):</div><ul>${d.openDiscussions
        .map(
          x =>
            `<li>${x.html_url ? ext(x.html_url, `#${x.number}`) : `#${esc(x.number)}`} ${esc(x.title)} — ${esc(x.author)}, ${esc(x.category ?? '-')}, ${esc(plural(x.comments ?? 0, 'comment'))}, ${esc(plural((x.reactions ?? 0) + (x.comment_reactions ?? 0), 'reaction'))}${x.last_comment ? `, last comment ${esc(x.last_comment.author)} ${esc(short(x.last_comment.at))}` : ''}${x.answered ? ', answered' : ''}</li>`
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
    links: `${r.html_url ? `${ext(r.html_url, 'GitHub')} · ` : ''}<a href="${queueHref(project)}">queue</a> · <a href="${noteHref(stateDocPath(project))}">state.md</a>`
  };
};
