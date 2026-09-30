// A project's tracker declaration: where its work is tracked and which tracker
// is primary (D95). Declared in the project's queue.md frontmatter, since the
// queue is the vault's own tracker and the declaration says what stands beside
// it; absent, the vault is primary. Read here for the route, the resume brief
// and bundle, and the project page, so every reader gets one validated answer.

import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {parseFrontmatter} from '../markdown/frontmatter.ts';

export const TRACKER_KINDS = ['vault', 'github', 'linear', 'jira'] as const;
export type TrackerKind = (typeof TRACKER_KINDS)[number];
export const TRACKER_ROLES = ['primary', 'secondary'] as const;
export const TRACKER_CREATE = ['here', 'none'] as const;
// How a secondary tracker's items reach the vault's queue (2026-09-30):
// reflected as items with a link, taken through `## Inbox` for triage, or not
// at all. A primary outside tracker takes none: the vault records the item in
// flight (D108), never a mirror.
export const TRACKER_INTAKE = ['none', 'reflect', 'triage'] as const;

export interface Tracker {
  kind: TrackerKind;
  /** The tracker's own name for the project: an owner/repo, a Linear team key, a Jira project key. */
  ref: string | null;
  role: 'primary' | 'secondary';
  /** Whether new work may be created there. */
  create: 'here' | 'none';
  /** How its items reach the vault's queue; `none` on the vault itself and on a primary. */
  intake: 'none' | 'reflect' | 'triage';
  /** The fields the vault may write back; empty means read-only. */
  write: string[];
  /** Where a person opens it; derived for GitHub when absent. */
  url: string | null;
}

export interface TrackersView {
  project: string;
  /** True when queue.md carries a `trackers:` key; false means the default. */
  declared: boolean;
  trackers: Tracker[];
  primary: Tracker;
  /** Why an entry was dropped or the list amended; empty when the declaration is well-formed. */
  problems: string[];
}

const VAULT_PRIMARY: Tracker = {
  kind: 'vault',
  ref: null,
  role: 'primary',
  create: 'here',
  intake: 'none',
  write: [],
  url: null
};

const KINDS = new Set<string>(TRACKER_KINDS);
const ROLES = new Set<string>(TRACKER_ROLES);
const CREATE = new Set<string>(TRACKER_CREATE);
const INTAKE = new Set<string>(TRACKER_INTAKE);

const urlFor = (kind: TrackerKind, ref: string | null, given: unknown): string | null => {
  if (typeof given === 'string' && /^https?:\/\//.test(given)) return given;
  if (kind === 'github' && ref && /^[\w.-]+\/[\w.-]+$/.test(ref))
    return `https://github.com/${ref}/issues`;
  return null;
};

/** The declaration as written, validated; `raw` is the frontmatter's `trackers` value. */
export const readTrackers = (project: string, raw: unknown): TrackersView => {
  if (raw === undefined || raw === null) {
    return {
      project,
      declared: false,
      trackers: [VAULT_PRIMARY],
      primary: VAULT_PRIMARY,
      problems: []
    };
  }
  const problems: string[] = [];
  const trackers: Tracker[] = [];
  const entries = Array.isArray(raw) ? raw : null;
  if (entries === null) {
    problems.push('trackers must be a list');
  } else {
    entries.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        problems.push(`trackers[${i}] must be a map`);
        return;
      }
      const e = entry as Record<string, unknown>;
      const kind = typeof e['kind'] === 'string' ? e['kind'] : '';
      if (!KINDS.has(kind)) {
        problems.push(
          `trackers[${i}].kind must be one of ${TRACKER_KINDS.join(', ')} (got ${JSON.stringify(e['kind'] ?? null)})`
        );
        return;
      }
      const ref = typeof e['ref'] === 'string' && e['ref'].trim() ? e['ref'].trim() : null;
      if (kind !== 'vault' && ref === null) {
        problems.push(`trackers[${i}] (${kind}) needs a ref`);
        return;
      }
      // `mirror` was the name until 2026-09-30; read, and named as stale.
      if (e['role'] === 'mirror') {
        problems.push(`trackers[${i}].role mirror is called secondary now`);
      }
      const role =
        e['role'] === 'mirror'
          ? 'secondary'
          : typeof e['role'] === 'string' && ROLES.has(e['role'])
            ? (e['role'] as Tracker['role'])
            : null;
      if (e['role'] !== undefined && role === null) {
        problems.push(`trackers[${i}].role must be primary or secondary`);
        return;
      }
      const create =
        typeof e['create'] === 'string' && CREATE.has(e['create'])
          ? (e['create'] as Tracker['create'])
          : null;
      if (e['create'] !== undefined && create === null) {
        problems.push(`trackers[${i}].create must be here or none`);
        return;
      }
      const intake =
        typeof e['intake'] === 'string' && INTAKE.has(e['intake'])
          ? (e['intake'] as Tracker['intake'])
          : null;
      if (e['intake'] !== undefined && intake === null) {
        problems.push(`trackers[${i}].intake must be none, reflect, or triage`);
        return;
      }
      if (intake !== null && intake !== 'none' && kind === 'vault') {
        problems.push(`trackers[${i}] (vault) takes no intake; it is the queue`);
      }
      const write = Array.isArray(e['write'])
        ? e['write'].filter((w): w is string => typeof w === 'string' && w.length > 0)
        : [];
      trackers.push({
        kind: kind as TrackerKind,
        ref,
        role: role ?? 'secondary',
        create: create ?? (role === 'primary' ? 'here' : 'none'),
        intake: kind === 'vault' ? 'none' : (intake ?? 'none'),
        write,
        url: urlFor(kind as TrackerKind, ref, e['url'])
      });
    });
  }
  const primaries = trackers.filter(t => t.role === 'primary');
  if (primaries.length > 1) {
    problems.push(`${primaries.length} trackers are primary; the first one counts`);
    for (const t of primaries.slice(1)) t.role = 'secondary';
  }
  // A primary outside the vault takes no intake: its items are not copied in;
  // the vault records the item in flight (D108).
  const first = primaries[0];
  if (first !== undefined && first.kind !== 'vault' && first.intake !== 'none') {
    problems.push(
      `the primary (${first.kind} ${first.ref}) takes no intake: the vault records the item in flight, not a mirror`
    );
    first.intake = 'none';
  }
  if (primaries.length === 0) {
    problems.push('no tracker is primary; the vault is');
    if (!trackers.some(t => t.kind === 'vault')) trackers.unshift({...VAULT_PRIMARY});
    else trackers.find(t => t.kind === 'vault')!.role = 'primary';
  }
  const primary = trackers.find(t => t.role === 'primary') ?? VAULT_PRIMARY;
  return {project, declared: true, trackers, primary, problems};
};

/**
 * The project's declaration from its queue.md on disk (a stored record's body
 * is frontmatter-stripped); the vault-primary default when there is none.
 */
export const projectTrackers = (vaultDataPath: string, project: string): TrackersView => {
  const path = join(vaultDataPath, 'projects', project, 'queue.md');
  if (!existsSync(path)) return readTrackers(project, undefined);
  let raw: unknown;
  try {
    raw = parseFrontmatter(readFileSync(path, 'utf8')).data['trackers'];
  } catch {
    raw = undefined;
  }
  return readTrackers(project, raw);
};

/** The one line a digest prints: `linear ENG (primary)` or `vault`. */
export const trackerLine = (view: TrackersView): string => {
  const p = view.primary;
  const name = p.kind === 'vault' ? 'vault' : `${p.kind} ${p.ref}`;
  const secondaries = view.trackers
    .filter(t => t.role === 'secondary')
    .map(t =>
      t.kind === 'vault'
        ? 'vault'
        : `${t.kind} ${t.ref}${t.intake === 'none' ? '' : ` (${t.intake})`}`
    );
  return secondaries.length ? `${name} (primary); secondary: ${secondaries.join(', ')}` : name;
};
