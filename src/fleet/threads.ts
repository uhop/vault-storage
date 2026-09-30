// A queue item's `source:` (D107) names the outside thread it mirrors; for a
// GitHub thread, the stored fleet-status baselines (D110) say whether it is
// still open, so the brief and the project page can mark an item whose thread
// closed upstream (D111). Stored data only: nothing here calls GitHub.

import type {DatabaseSync, StatementSync} from 'node:sqlite';
import {OPEN_ORDER} from '../queue/repo.ts';

export type ThreadKind = 'item' | 'discussion' | 'advisory';

export interface GithubThread {
  repo: string;
  kind: ThreadKind;
  /** The issue, PR, or discussion number, or the advisory's GHSA id. */
  key: string;
}

export interface ThreadState {
  /**
   * `open`, `closed`, or `merged` for an issue or PR, `open` or `closed` for a
   * discussion, the advisory's own state for an advisory; null when no stored
   * baseline carries the thread.
   */
  upstream: string | null;
  url: string | null;
}

export interface TrackedItem extends ThreadState {
  title: string;
  section: string;
  source: string;
}

// The three shapes `fleet-status.mjs file --source` writes.
const SOURCE_RE =
  /^github ([\w.-]+\/[\w.-]+)(?:#(\d+)| discussion#(\d+)| GHSA-([a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}))$/i;

const GROUP: Record<ThreadKind, string> = {
  item: 'items',
  discussion: 'discussions',
  advisory: 'advisories'
};

/** The GitHub thread a normalized `source:` names; null for any other source. */
export const githubThread = (source: string): GithubThread | null => {
  const m = SOURCE_RE.exec(source);
  if (!m) return null;
  const repo = m[1]!;
  if (m[2] !== undefined) return {repo, kind: 'item', key: m[2]};
  if (m[3] !== undefined) return {repo, kind: 'discussion', key: m[3]};
  return {repo, kind: 'advisory', key: `GHSA-${m[4]!.toLowerCase()}`};
};

/** The states after which an item has nothing left upstream to track. */
export const closedUpstream = (upstream: string | null): boolean =>
  upstream === 'closed' || upstream === 'merged';

const asObject = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const stringOr = (v: unknown): string | null => (typeof v === 'string' ? v : null);

interface Statements {
  tracked: StatementSync;
  byRepo: StatementSync;
}

// Prepared once per database: every project read and every brief asks.
const statements = new WeakMap<DatabaseSync, Statements>();
const prepared = (db: DatabaseSync): Statements => {
  let s = statements.get(db);
  if (s === undefined) {
    s = {
      tracked: db.prepare(
        `SELECT title, section, source FROM queue_items
          WHERE project = ? AND section != 'archive' AND source IS NOT NULL
          ORDER BY ${OPEN_ORDER}`
      ),
      // GitHub repository names are case-insensitive; the freshest baseline wins
      // when two projects store the same repository.
      byRepo: db.prepare(
        `SELECT github FROM fleet_baselines
          WHERE lower(repo) = lower(?) AND github IS NOT NULL
          ORDER BY github_collected_at DESC LIMIT 1`
      )
    };
    statements.set(db, s);
  }
  return s;
};

/** Thread states from the stored baselines, each repository's parsed once per instance. */
export class GithubThreadStates {
  readonly #byRepo: StatementSync;
  readonly #parsed = new Map<string, Record<string, unknown> | null>();

  constructor(db: DatabaseSync) {
    this.#byRepo = prepared(db).byRepo;
  }

  #github(repo: string): Record<string, unknown> | null {
    const key = repo.toLowerCase();
    let github = this.#parsed.get(key);
    if (github === undefined) {
      const row = this.#byRepo.get(repo) as {github: string} | undefined;
      github = row ? asObject(JSON.parse(row.github)) : null;
      this.#parsed.set(key, github);
    }
    return github;
  }

  state(thread: GithubThread): ThreadState {
    const entry = asObject(asObject(this.#github(thread.repo)?.[GROUP[thread.kind]])?.[thread.key]);
    if (!entry) return {upstream: null, url: null};
    if (thread.kind === 'discussion')
      return {upstream: entry['closed'] === true ? 'closed' : 'open', url: stringOr(entry['url'])};
    return {upstream: stringOr(entry['state']), url: stringOr(entry['html_url'])};
  }

  /** The state of the thread a source names; null upstream for a source outside GitHub. */
  ofSource(source: string | null): ThreadState {
    const thread = source === null ? null : githubThread(source);
    return thread ? this.state(thread) : {upstream: null, url: null};
  }
}

/** A project's open queue items that mirror a GitHub thread, in queue order, with its state. */
export const trackedItems = (db: DatabaseSync, project: string): TrackedItem[] => {
  const rows = prepared(db).tracked.all(project) as unknown[] as {
    title: string;
    section: string;
    source: string;
  }[];
  const states = new GithubThreadStates(db);
  const out: TrackedItem[] = [];
  for (const row of rows) {
    const thread = githubThread(row.source);
    if (thread) out.push({...row, ...states.state(thread)});
  }
  return out;
};
