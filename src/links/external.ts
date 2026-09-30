// The index of external links (D112): each outside object a note mentions,
// keyed as a queue item's `source:` spells it, so a ticket, a design, or an
// error lists the notes and queue items that mention it. A bare `#n` means the
// note's project's repository, which can change without the note changing
// (D97), so it is stored unresolved and resolved at lookup.

import type {DatabaseSync, StatementSync} from 'node:sqlite';
import {githubThread, type GithubThread} from '../fleet/threads.ts';
import {maskCodeRegions} from '../markdown/wikilinks.ts';
import {normalizeSource, SOURCE_RE} from '../queue/parse.ts';
import {matchQueueFile} from '../queue/sync.ts';
import {REF_BLOCKED} from '../render/refs.ts';
import {readTrackers} from '../server/trackers.ts';

export interface Mention {
  key: string;
  raw: string;
  url: string | null;
}

export interface LinkMention {
  record_id: string;
  file_path: string;
  title: string | null;
  type: string;
  project: string | null;
  raw: string[];
  queue_items: {title: string; section: string}[];
}

export interface LinkEntry {
  key: string;
  url: string | null;
  mentions: LinkMention[];
}

// A balanced pair of parentheses stays inside a URL; an unbalanced one closes a markdown link.
const URL_RE = /\bhttps?:\/\/(?:[^\s<>"'`()[\]{}|\\^]|\([^\s<>"'`()]*\))+/gi;
const TRAILING = /[.,;:!?*_~]+$/;
// A reference is found from its `#`: src/render/refs.ts's pattern, with its
// optional `owner/repo` first, tries every word, 5.8 ms on a 320 KB note.
const HASH_RE = /#([1-9]\d{0,8})(?!\w)/g;
const QUALIFIER = /(?<![\w/&#.-])([\w.-]+\/[\w.-]+)$/;
const DIGITS = /^[1-9]\d*$/;
const GHSA = /^GHSA-([a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/i;
const TRACKER_KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9]\d*$/;
const KEYED_SOURCE = /^(linear|jira) ([A-Z][A-Z0-9]{1,9}-[1-9]\d*)$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;

export const threadKey = (t: GithubThread): string => {
  const repo = t.repo.toLowerCase();
  if (t.kind === 'discussion') return `github ${repo} discussion#${t.key}`;
  if (t.kind === 'advisory') return `github ${repo} ${t.key}`;
  return `github ${repo}#${t.key}`;
};

const githubKey = (path: string[]): string | null => {
  const [owner, name, section, id, advisory] = path;
  if (!owner || !name || !id) return null;
  const repo = `${owner}/${name}`.toLowerCase();
  if ((section === 'issues' || section === 'pull') && DIGITS.test(id))
    return `github ${repo}#${id}`;
  if (section === 'discussions' && DIGITS.test(id)) return `github ${repo} discussion#${id}`;
  const ghsa = section === 'security' && id === 'advisories' ? GHSA.exec(advisory ?? '') : null;
  return ghsa ? `github ${repo} GHSA-${ghsa[1]!.toLowerCase()}` : null;
};

const gitlabKey = (path: string[]): string | null => {
  const dash = path.indexOf('-');
  const kind = path[dash + 1];
  const id = path[dash + 2];
  if (dash < 2 || !id || !DIGITS.test(id)) return null;
  const project = path.slice(0, dash).join('/').toLowerCase();
  if (kind === 'issues' || kind === 'work_items') return `gitlab ${project}#${id}`;
  return kind === 'merge_requests' ? `gitlab ${project}!${id}` : null;
};

const bitbucketKey = (path: string[]): string | null => {
  const [workspace, name, section, id] = path;
  if (!workspace || !name || !id || !DIGITS.test(id)) return null;
  const repo = `${workspace}/${name}`.toLowerCase();
  if (section === 'issues') return `bitbucket ${repo}#${id}`;
  return section === 'pull-requests' ? `bitbucket ${repo}!${id}` : null;
};

const FIGMA_KINDS: ReadonlySet<string> = new Set(['file', 'design', 'proto', 'board']);

const vendorKey = (host: string, path: string[]): string | null => {
  const [a, b, c, d] = path;
  if (host === 'github.com') return githubKey(path);
  if (host === 'gitlab.com') return gitlabKey(path);
  if (host === 'bitbucket.org') return bitbucketKey(path);
  if (host === 'figma.com') return b && FIGMA_KINDS.has(a ?? '') ? `figma ${b}` : null;
  if (host === 'sentry.io')
    return a === 'organizations' && b && c === 'issues' && d && DIGITS.test(d)
      ? `sentry ${b}/${d}`
      : null;
  if (host.endsWith('.sentry.io'))
    return a === 'issues' && b && DIGITS.test(b)
      ? `sentry ${host.slice(0, -'.sentry.io'.length)}/${b}`
      : null;
  if (host.endsWith('.slack.com'))
    return a === 'archives' && b && c && /^p\d+$/.test(c)
      ? `slack ${host.slice(0, -'.slack.com'.length)}/${b}/${c}`
      : null;
  if (host === 'linear.app')
    return b === 'issue' && c && TRACKER_KEY.test(c) ? `linear ${c}` : null;
  if (host.endsWith('.atlassian.net'))
    return a === 'browse' && b && TRACKER_KEY.test(b) ? `jira ${b}` : null;
  return null;
};

/**
 * The key of the object a URL names: a vendor's own object where the URL has
 * its shape (the per-tool notes under `projects/vault-storage/integrations/`),
 * else `url` and the URL with its scheme and host lowercased and its fragment
 * and trailing slash dropped. Null for anything but http(s).
 */
export const linkKey = (raw: string): string | null => {
  if (!URL.canParse(raw)) return null;
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const path = u.pathname.split('/').filter(s => s.length > 0);
  const key = vendorKey(u.hostname.replace(/^www\./, ''), path);
  if (key !== null) return key;
  const pathname = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
  return `url ${u.protocol}//${u.host}${pathname}${u.search}`;
};

/** The key of a queue item's `source:`; null for a kind the index does not know. */
export const sourceKey = (source: string): string | null => {
  const thread = githubThread(source);
  if (thread) return threadKey(thread);
  const keyed = KEYED_SOURCE.exec(source);
  return keyed ? `${keyed[1]} ${keyed[2]}` : null;
};

/**
 * A lookup key as a caller writes it: a GitHub thread in any case or spacing
 * comes back in the index's spelling; any other key only has its spaces collapsed.
 */
export const normalizeKey = (raw: string): string => {
  const key = normalizeSource(raw);
  return sourceKey(key) ?? key;
};

/** Every outside object a note mentions, outside code, one entry per key and text. */
export const extractMentions = (
  relativePath: string,
  body: string,
  project: string | null
): Mention[] => {
  const out = new Map<string, Mention>();
  const add = (key: string, raw: string, url: string | null): void => {
    const id = `${key}\t${raw}`;
    if (!out.has(id)) out.set(id, {key, raw, url});
  };
  let text = maskCodeRegions(body);
  if (matchQueueFile(relativePath)) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; ++i) {
      const m = SOURCE_RE.exec(lines[i]!);
      if (!m) continue;
      const source = normalizeSource(m[1]!);
      const key = sourceKey(source);
      if (key === null) continue;
      add(key, source, null);
      lines[i] = ' '.repeat(lines[i]!.length);
    }
    text = lines.join('\n');
  }
  text = text.replace(URL_RE, match => {
    const url = match.replace(TRAILING, '');
    const key = linkKey(url);
    if (key !== null) add(key, url, url);
    return ' '.repeat(match.length);
  });
  for (const m of text.matchAll(HASH_RE)) {
    const before = text.slice(Math.max(0, m.index - 256), m.index);
    const n = m[1]!;
    if (!REF_BLOCKED.test(before)) {
      if (project !== null) add(`#${n}`, `#${n}`, null);
      continue;
    }
    const repo = QUALIFIER.exec(before)?.[1];
    if (repo !== undefined) add(`github ${repo.toLowerCase()}#${n}`, `${repo}#${n}`, null);
  }
  return [...out.values()];
};

interface Statements {
  deleteLinks: StatementSync;
  insertLink: StatementSync;
  deleteGithub: StatementSync;
  upsertGithub: StatementSync;
  byKey: StatementSync;
  byRepo: StatementSync;
  bareIn: StatementSync;
  declared: StatementSync;
  baselines: StatementSync;
  queueItems: StatementSync;
}

const MENTION_COLUMNS = `l.key, l.raw, l.url, l.project, r.record_id, r.file_path, r.title, r.type
  FROM external_links l JOIN records r ON r.record_id = l.record_id`;

// Prepared once per database: every import applies, and every lookup reads (see 4b).
const statements = new WeakMap<DatabaseSync, Statements>();
const prepared = (db: DatabaseSync): Statements => {
  let s = statements.get(db);
  if (s === undefined) {
    s = {
      deleteLinks: db.prepare('DELETE FROM external_links WHERE record_id = ?'),
      insertLink: db.prepare(
        `INSERT OR IGNORE INTO external_links (record_id, key, raw, url, project)
         VALUES (?, ?, ?, ?, ?)`
      ),
      deleteGithub: db.prepare('DELETE FROM project_github WHERE record_id = ?'),
      upsertGithub: db.prepare(
        `INSERT INTO project_github (record_id, project, repo) VALUES (?, ?, ?)
         ON CONFLICT(record_id) DO UPDATE SET project = excluded.project, repo = excluded.repo`
      ),
      byKey: db.prepare(`SELECT ${MENTION_COLUMNS} WHERE l.key = ? ORDER BY r.file_path`),
      byRepo: db.prepare(
        `SELECT ${MENTION_COLUMNS}
          WHERE l.key LIKE ? ESCAPE '\\' OR l.key LIKE ? ESCAPE '\\'
          ORDER BY r.file_path`
      ),
      bareIn: db.prepare(
        `SELECT ${MENTION_COLUMNS}
          WHERE l.key GLOB ? AND l.project IN (SELECT value FROM json_each(?))
          ORDER BY r.file_path`
      ),
      declared: db.prepare('SELECT project, repo FROM project_github'),
      baselines: db.prepare(
        'SELECT project, lower(repo) AS repo FROM fleet_baselines WHERE repo IS NOT NULL'
      ),
      queueItems: db.prepare('SELECT title, section, body FROM queue_items WHERE source_file = ?')
    };
    statements.set(db, s);
  }
  return s;
};

interface Row {
  key: string;
  raw: string;
  url: string | null;
  project: string | null;
  record_id: string;
  file_path: string;
  title: string | null;
  type: string;
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, c => `\\${c}`);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The text as a whole token, so `#23` is not found inside `#233`.
const holds = (text: string, raw: string): boolean =>
  new RegExp(`(?<![\\w/&#.-])${escapeRe(raw)}(?!\\w)`).test(text);

export class ExternalLinksRepository {
  readonly #s: Statements;

  constructor(db: DatabaseSync) {
    this.#s = prepared(db);
  }

  /**
   * Keep the record's rows in step with its body, and a queue's declared
   * `github` tracker with its frontmatter. Returns the mentions written.
   */
  apply(
    recordId: string,
    relativePath: string,
    project: string | null,
    body: string,
    frontmatter: Record<string, unknown>
  ): number {
    const s = this.#s;
    s.deleteLinks.run(recordId);
    const mentions = extractMentions(relativePath, body, project);
    for (const m of mentions) s.insertLink.run(recordId, m.key, m.raw, m.url, project);
    const queue = relativePath.endsWith('/queue.md') ? matchQueueFile(relativePath) : null;
    const repo = queue
      ? readTrackers(queue.project, frontmatter['trackers']).trackers.find(t => t.kind === 'github')
          ?.ref
      : null;
    if (queue && repo && REPO.test(repo))
      s.upsertGithub.run(recordId, queue.project, repo.toLowerCase());
    else s.deleteGithub.run(recordId);
    return mentions.length;
  }

  /** Each project's repository: its declared `github` tracker, else the stored baseline's (D97). */
  #projectRepos(): Map<string, string> {
    const repos = new Map<string, string>();
    for (const r of this.#s.baselines.all() as unknown[] as {project: string; repo: string}[])
      repos.set(r.project, r.repo);
    for (const r of this.#s.declared.all() as unknown[] as {project: string; repo: string}[])
      repos.set(r.project, r.repo);
    return repos;
  }

  #projectsOf(repo: string): string[] {
    return [...this.#projectRepos()].filter(([, r]) => r === repo).map(([p]) => p);
  }

  /** The notes that mention one object, a bare `#n` included where its project's repository is the object's. */
  byKey(key: string): LinkEntry {
    const rows = this.#s.byKey.all(key) as unknown[] as Row[];
    const thread = githubThread(key);
    if (thread?.kind === 'item') {
      const projects = this.#projectsOf(thread.repo.toLowerCase());
      if (projects.length > 0)
        rows.push(
          ...(this.#s.bareIn.all(`#${thread.key}`, JSON.stringify(projects)) as unknown[] as Row[])
        );
    }
    return this.#entries(rows.map(r => ({...r, key})))[0] ?? {key, url: null, mentions: []};
  }

  /** Every thread of a repository that a note mentions, from any project's notes. */
  byRepo(repo: string): LinkEntry[] {
    const lower = repo.toLowerCase();
    const prefix = `github ${likeEscape(lower)}`;
    const rows = this.#s.byRepo.all(`${prefix}#%`, `${prefix} %`) as unknown[] as Row[];
    const projects = this.#projectsOf(lower);
    if (projects.length > 0) {
      const bare = this.#s.bareIn.all('#*', JSON.stringify(projects)) as unknown[] as Row[];
      for (const r of bare) rows.push({...r, key: `github ${lower}${r.key}`});
    }
    return this.#entries(rows);
  }

  /** Rows grouped by key, then by note, each note with the queue items that hold its text. */
  #entries(rows: Row[]): LinkEntry[] {
    const items = new Map<string, {title: string; section: string; body: string}[]>();
    const itemsOf = (filePath: string) => {
      let list = items.get(filePath);
      if (list === undefined) {
        list = matchQueueFile(filePath)
          ? (this.#s.queueItems.all(filePath) as unknown[] as {
              title: string;
              section: string;
              body: string;
            }[])
          : [];
        items.set(filePath, list);
      }
      return list;
    };
    const byKey = new Map<string, LinkEntry>();
    const byNote = new Map<string, LinkMention>();
    for (const r of rows) {
      let entry = byKey.get(r.key);
      if (entry === undefined) {
        entry = {key: r.key, url: null, mentions: []};
        byKey.set(r.key, entry);
      }
      entry.url ??= r.url;
      const id = `${r.key}\t${r.record_id}`;
      let mention = byNote.get(id);
      if (mention === undefined) {
        mention = {
          record_id: r.record_id,
          file_path: r.file_path,
          title: r.title,
          type: r.type,
          project: r.project,
          raw: [],
          queue_items: []
        };
        byNote.set(id, mention);
        entry.mentions.push(mention);
      }
      if (!mention.raw.includes(r.raw)) mention.raw.push(r.raw);
    }
    for (const mention of byNote.values()) {
      mention.queue_items = itemsOf(mention.file_path)
        .filter(it => mention.raw.some(raw => holds(it.title, raw) || holds(it.body, raw)))
        .map(({title, section}) => ({title, section}));
    }
    const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    for (const entry of byKey.values())
      entry.mentions.sort((a, b) => order(a.file_path, b.file_path));
    return [...byKey.values()].sort((a, b) => order(a.key, b.key));
  }
}
