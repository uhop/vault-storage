// Body-wikilink classifier (heuristic-only per design constraint C16).
//
// Looks at the immediate context around each `[[wikilink]]` occurrence in the
// body and matches keyword patterns to edge types. Default for un-cued links
// is `cites` (the design's "everything else" edge type for body mentions).
//
// Two pattern sets:
//   PRE  — keyword precedes the wikilink: "supersedes [[X]]", "derived from [[Y]]"
//   POST — keyword follows the wikilink:  "[[X]] applies to ...", "[[X]] caused by ..."
//
// Patterns are ordered; first match wins. Same-target multiple-occurrence
// resolution promotes to the strongest type seen.

import type {EdgeType} from '../records/types.ts';

export interface Classified {
  target: string;
  type: EdgeType;
}

interface Pattern {
  type: EdgeType;
  re: RegExp;
}

// PRE patterns match against the right-trimmed end of the left context — the
// keyword should sit immediately before the wikilink, with at most some
// whitespace between.
const PRE_PATTERNS: Pattern[] = [
  {type: 'supersedes', re: /\bsupersed(?:es|ed by)\s+$/i},
  {type: 'supersedes', re: /\breplaces?\s+$/i},
  {type: 'revises', re: /\b(?:revises?|refines?)\s+$/i},
  {type: 'derived-from', re: /\bderived from\s+$/i},
  {type: 'derived-from', re: /\bbased on\s+$/i},
  {type: 'caused-by', re: /\bcaused by\s+$/i},
  {type: 'caused-by', re: /\b(?:triggered|provoked) by\s+$/i},
  {type: 'caused-by', re: /\bdue to\s+$/i},
  {type: 'fixed-by', re: /\bfixed by\s+$/i},
  {type: 'fixed-by', re: /\bresolved by\s+$/i},
  {type: 'rejected-because', re: /\brejected because of\s+$/i},
  {type: 'rejected-because', re: /\brejected because\s+$/i},
  {type: 'applies-to', re: /\bapplies to\s+$/i},
  {type: 'applies-to', re: /\brelevant to\s+$/i},
  {type: 'contradicts', re: /\bcontradicts?\s+$/i},
  {type: 'contradicts', re: /\bdisagrees? with\s+$/i}
];

// POST patterns match the very start of the right context. Catches phrases
// like "[[X]] applies to ..." or "[[X]] supersedes ...".
const POST_PATTERNS: Pattern[] = [
  {type: 'applies-to', re: /^\s+applies to\b/i},
  {type: 'applies-to', re: /^\s+is relevant to\b/i},
  {type: 'supersedes', re: /^\s+(?:supersedes|replaces)\b/i},
  {type: 'revises', re: /^\s+(?:revises|refines)\b/i},
  {type: 'fixed-by', re: /^\s+fixes\b/i}
];

const WINDOW_BEFORE = 80;
const WINDOW_AFTER = 40;
// Wikilink token at body level: [[target]] or [[target|display]].
const WIKILINK_RE = /\[\[([^\]\n|[]+?)(?:\|[^\]]*)?\]\]/g;

/**
 * Scan a body for wikilinks and classify each. Body links that match no
 * keyword pattern get `cites` (the design's default for body mentions).
 * Symmetric edge types (`contradicts`, `related-to`) are detected here but
 * auto-mirroring is the caller's responsibility.
 *
 * Multiple occurrences of the same target collapse to the strongest type seen
 * (`supersedes` > `revises` > `derived-from` > … > `cites`).
 */
export const classifyBodyLinks = (body: string): Classified[] => {
  const byTarget = new Map<string, EdgeType>();

  for (const match of body.matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim();
    if (!target) continue;

    const at = match.index ?? 0;
    const before = body.slice(Math.max(0, at - WINDOW_BEFORE), at);
    const after = body.slice(at + match[0].length, at + match[0].length + WINDOW_AFTER);

    let type: EdgeType = 'cites';
    for (const pat of PRE_PATTERNS) {
      if (pat.re.test(before)) {
        type = pat.type;
        break;
      }
    }
    if (type === 'cites') {
      for (const pat of POST_PATTERNS) {
        if (pat.re.test(after)) {
          type = pat.type;
          break;
        }
      }
    }

    const prior = byTarget.get(target);
    if (prior === undefined || edgeRank(type) < edgeRank(prior)) {
      byTarget.set(target, type);
    }
  }

  return [...byTarget.entries()].map(([target, type]) => ({target, type}));
};

/** Lower rank = stronger / more specific edge type. `cites` is the weakest. */
const RANK: Record<EdgeType, number> = {
  supersedes: 0,
  revises: 1,
  'derived-from': 2,
  'caused-by': 3,
  'fixed-by': 4,
  'rejected-because': 5,
  contradicts: 6,
  'applies-to': 7,
  'related-to': 8,
  cites: 9
};

const edgeRank = (t: EdgeType): number => RANK[t];
