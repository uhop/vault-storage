// What a short reference in a note resolves to (src/render/refs.ts): the
// project's declared trackers (D95) give the repository and the key prefixes,
// and the GitHub baseline the fleet-status collector stores in the project's
// state.md gives the titles, so a render makes no network call.

import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Ref, RefLink, ResolveRef} from '../render/refs.ts';
import {projectTrackers, type Tracker} from './trackers.ts';

interface Baseline {
  repo: string;
  items: Record<string, unknown>;
}

interface Own {
  trackers: Tracker[];
  repo: string | null;
  baseline: Baseline | null;
}

const KEYED: ReadonlySet<string> = new Set(['linear', 'jira']);

const PROJECT_OF = /^projects\/([a-z0-9][a-z0-9._-]*)\//;
// A leading word character keeps `..` out of the path.
const PROJECT_NAME = /^\w[\w.-]*$/;
const GITHUB_BLOCK = /^## GitHub[ \t]*\n[\s\S]*?^```json\n([\s\S]*?)^```/m;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const readBaseline = (vaultDataPath: string, project: string): Baseline | null => {
  if (!PROJECT_NAME.test(project)) return null;
  const path = join(vaultDataPath, 'projects', project, 'state.md');
  if (!existsSync(path)) return null;
  const block = GITHUB_BLOCK.exec(readFileSync(path, 'utf8'))?.[1];
  if (block === undefined) return null;
  let data: Record<string, unknown> | null;
  try {
    data = asRecord(JSON.parse(block));
  } catch {
    return null;
  }
  const repo = data?.['repo'];
  if (typeof repo !== 'string') return null;
  return {repo, items: asRecord(data?.['items']) ?? {}};
};

const sameRepo = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

const issueUrl = (repo: string, n: number): string => `https://github.com/${repo}/issues/${n}`;

const githubLink = (repo: string, n: number, baseline: Baseline | null): RefLink => {
  const item = baseline && sameRepo(baseline.repo, repo) ? asRecord(baseline.items[n]) : null;
  const url = item?.['html_url'];
  const title = item?.['title'];
  const state = item?.['state'];
  return {
    url: typeof url === 'string' && url.startsWith('https://') ? url : issueUrl(repo, n),
    title: typeof title === 'string' ? title : null,
    state: typeof state === 'string' ? state : null
  };
};

const keyUrl = (tracker: Tracker, key: string): string | null => {
  if (tracker.url === null || !URL.canParse(tracker.url)) return null;
  const at = new URL(tracker.url);
  if (tracker.kind === 'jira') return `${at.origin}/browse/${key}`;
  const workspace = at.pathname.split('/')[1];
  return workspace ? `${at.origin}/${workspace}/issue/${key}` : null;
};

/**
 * The resolver for one note. `#N` means the project's own GitHub repository:
 * the declared `github` tracker, else the repository the stored baseline
 * names. `owner/repo#N` links when the vault knows the repository, or when
 * the note's project is on GitHub, which settles the forge. A key links when
 * the project declares a Linear or Jira tracker with that key and a URL. A
 * note outside `projects/` resolves only a repository the vault knows.
 */
export const refResolver = (vaultDataPath: string, notePath: string | null): ResolveRef => {
  const project = notePath === null ? null : (PROJECT_OF.exec(notePath)?.[1] ?? null);
  const baselines = new Map<string, Baseline | null>();
  const baselineOf = (name: string): Baseline | null => {
    let baseline = baselines.get(name);
    if (baseline === undefined) {
      baseline = readBaseline(vaultDataPath, name);
      baselines.set(name, baseline);
    }
    return baseline;
  };

  const readOwn = (): Own => {
    if (project === null) return {trackers: [], repo: null, baseline: null};
    const {trackers} = projectTrackers(vaultDataPath, project);
    const baseline = baselineOf(project);
    const declared = trackers.find(t => t.kind === 'github')?.ref ?? null;
    return {trackers, repo: declared ?? baseline?.repo ?? null, baseline};
  };
  let own: Own | undefined;

  return (ref: Ref): RefLink | null => {
    own ??= readOwn();
    if (ref.kind === 'key') {
      const tracker = own.trackers.find(t => KEYED.has(t.kind) && t.ref === ref.prefix);
      const url = tracker ? keyUrl(tracker, `${ref.prefix}-${ref.n}`) : null;
      return url === null ? null : {url, title: null, state: null};
    }
    const {repo, baseline} = own;
    if (ref.repo === null) return repo === null ? null : githubLink(repo, ref.n, baseline);
    if (repo !== null && sameRepo(repo, ref.repo)) return githubLink(repo, ref.n, baseline);
    const name = ref.repo.slice(ref.repo.indexOf('/') + 1).toLowerCase();
    const known = baselineOf(name);
    if (known && sameRepo(known.repo, ref.repo)) return githubLink(known.repo, ref.n, known);
    return repo === null ? null : githubLink(ref.repo, ref.n, null);
  };
};
