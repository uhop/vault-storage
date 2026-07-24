// Query-time blocker resolution + ready/blocked computation over queue_items
// rows. Refs are normalized-title substrings (optionally `<project>/`-prefixed
// for cross-project blockers), matched against `title_norm`. Nothing resolved
// is ever stored — the table's DELETE+INSERT identity model (title edits,
// section moves) would strand stored ids, and the whole fleet's table is small
// enough that per-request resolution is trivial.
//
// Semantics (design: projects/vault-storage/design/queue-items-table.md,
// 2026-07-23 addendum):
//   - a ref resolving to an ARCHIVE item is a closed blocker → does not block;
//   - a ref resolving to an open item (active/backlog/watching) blocks;
//   - an unresolved or ambiguous ref BLOCKS and is flagged — never silently
//     satisfied (the silent-empty-result rule: a typo'd ref must surface as
//     loud blockage in the blocked view, not as quiet readiness);
//   - ready = Backlog items with zero blocking refs. Active is already
//     started and Watching is upstream-gated, so neither is "claimable next"
//     (the beads open-vs-in_progress split mapped onto our sections);
//   - cycles over open→open resolved edges are flagged on every member — a
//     cycle can never self-release, so it is a data bug worth surfacing.

import {normalizeTitle} from './parse.ts';
import type {QueueItemRow} from './repo.ts';

export type BlockerState = 'open' | 'closed' | 'unresolved' | 'ambiguous';

export interface ResolvedBlocker {
  ref: string;
  state: BlockerState;
  /** Present when state is open/closed: the single item the ref resolved to. */
  target?: {id: string; project: string; section: string; title: string};
  /** Present when state is ambiguous: how many items matched. */
  matches?: number;
}

export interface BlockerReport {
  item: QueueItemRow;
  blockers: ResolvedBlocker[];
  /** True when at least one blocker has state open/unresolved/ambiguous. */
  blocked: boolean;
  /** True when the item sits on a cycle of open resolved edges. */
  inCycle: boolean;
}

/**
 * Resolve one ref against the universe. Order: exact `title_norm` in the
 * ref's home project → unique substring in the home project → the same two
 * steps in `<project>` when the ref carries a `<project>/` prefix whose
 * prefix names a known project (checked at every `/` because titles
 * legitimately contain slashes). First rule that yields exactly one match
 * wins; a rule yielding 2+ stops resolution as ambiguous.
 */
const resolveRef = (
  ref: string,
  homeProject: string,
  universe: ReadonlyArray<QueueItemRow>
): ResolvedBlocker => {
  const attempts: Array<{project: string; needle: string}> = [
    {project: homeProject, needle: normalizeTitle(ref)}
  ];
  let slash = ref.indexOf('/');
  while (slash > 0) {
    const prefix = ref.slice(0, slash).trim();
    const rest = ref.slice(slash + 1).trim();
    if (rest.length > 0 && universe.some(row => row.project === prefix)) {
      attempts.push({project: prefix, needle: normalizeTitle(rest)});
    }
    slash = ref.indexOf('/', slash + 1);
  }

  for (const {project, needle} of attempts) {
    if (needle.length === 0) continue;
    const inProject = universe.filter(row => row.project === project);
    const exact = inProject.filter(row => row.title_norm === needle);
    const candidates =
      exact.length > 0 ? exact : inProject.filter(row => row.title_norm.includes(needle));
    if (candidates.length === 0) continue;
    if (candidates.length > 1) return {ref, state: 'ambiguous', matches: candidates.length};
    const hit = candidates[0]!;
    return {
      ref,
      state: hit.section === 'archive' ? 'closed' : 'open',
      target: {id: hit.id, project: hit.project, section: hit.section, title: hit.title}
    };
  }
  return {ref, state: 'unresolved'};
};

const blocks = (state: BlockerState): boolean => state !== 'closed';

/**
 * Resolve every item's blockers against `universe` (which must contain the
 * items themselves plus everything refs may point at — in practice the whole
 * table, or one project's slice plus cross-project targets). Cycle detection
 * runs over open→open resolved edges via iterative DFS.
 */
export const resolveBlockers = (
  items: ReadonlyArray<QueueItemRow>,
  universe: ReadonlyArray<QueueItemRow>
): BlockerReport[] => {
  const reports: BlockerReport[] = items.map(item => {
    const blockers = item.blocked_by.map(ref => resolveRef(ref, item.project, universe));
    return {item, blockers, blocked: blockers.some(b => blocks(b.state)), inCycle: false};
  });

  // Cycle detection over the open-edge graph, restricted to nodes present in
  // `items`. Colors: 0 unvisited, 1 on stack, 2 done. Any back-edge marks
  // every node on the current stack segment from the target onward.
  const byId = new Map<string, BlockerReport>(reports.map(r => [r.item.id, r]));
  const color = new Map<string, number>();
  const stack: string[] = [];

  const visit = (startId: string): void => {
    const frames: Array<{id: string; edges: string[]; next: number}> = [];
    const openEdges = (id: string): string[] => {
      const report = byId.get(id);
      if (!report) return [];
      return report.blockers
        .filter(b => b.state === 'open' && b.target && byId.has(b.target.id))
        .map(b => b.target!.id);
    };
    color.set(startId, 1);
    stack.push(startId);
    frames.push({id: startId, edges: openEdges(startId), next: 0});
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      if (frame.next >= frame.edges.length) {
        frames.pop();
        stack.pop();
        color.set(frame.id, 2);
        continue;
      }
      const target = frame.edges[frame.next]!;
      ++frame.next;
      const c = color.get(target) ?? 0;
      if (c === 0) {
        color.set(target, 1);
        stack.push(target);
        frames.push({id: target, edges: openEdges(target), next: 0});
      } else if (c === 1) {
        for (let i = stack.lastIndexOf(target); i >= 0 && i < stack.length; ++i) {
          const report = byId.get(stack[i]!);
          if (report) report.inCycle = true;
        }
      }
    }
  };

  for (const report of reports) {
    if ((color.get(report.item.id) ?? 0) === 0) visit(report.item.id);
  }

  return reports;
};

/**
 * Backlog items with no blocking refs, ordered `(priority DESC, project,
 * position)` — the "claimable next" view.
 */
export const readyView = (
  candidates: ReadonlyArray<QueueItemRow>,
  universe: ReadonlyArray<QueueItemRow>
): QueueItemRow[] =>
  resolveBlockers(
    candidates.filter(row => row.section === 'backlog'),
    universe
  )
    .filter(report => !report.blocked)
    .map(report => report.item)
    .sort(
      (a, b) =>
        b.priority - a.priority || a.project.localeCompare(b.project) || a.position - b.position
    );

/**
 * Open items (any open section) with at least one blocking ref, with per-ref
 * resolution detail and cycle flags. Ordered like the ready view.
 */
export const blockedView = (
  candidates: ReadonlyArray<QueueItemRow>,
  universe: ReadonlyArray<QueueItemRow>
): BlockerReport[] =>
  resolveBlockers(
    candidates.filter(row => row.section !== 'archive' && row.blocked_by.length > 0),
    universe
  )
    .filter(report => report.blocked)
    .sort(
      (a, b) =>
        b.item.priority - a.item.priority ||
        a.item.project.localeCompare(b.item.project) ||
        a.item.position - b.item.position
    );
