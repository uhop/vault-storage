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
import {maskCodeRegions} from '../markdown/wikilinks.ts';

export interface Classified {
  target: string;
  type: EdgeType;
  /**
   * When true, the edge runs target→source rather than source→target.
   * Set for passive constructions like "superseded by [[X]]" — the actor is
   * the target, so the directional edge points the other way.
   */
  inverse?: boolean;
}

interface Pattern {
  type: EdgeType;
  re: RegExp;
  /** When true, the edge points target→source instead of source→target. */
  inverse?: boolean;
}

// PRE patterns match against the right-trimmed end of the left context — the
// keyword should sit immediately before the wikilink, with at most some
// whitespace between.
const PRE_PATTERNS: Pattern[] = [
  // Active form: source supersedes target.
  {type: 'supersedes', re: /\b(?:supersedes?|replaces?|obsoletes?)\s+$/i},
  // Passive form: source is superseded by target → flip.
  {type: 'supersedes', inverse: true, re: /\b(?:superseded by|replaced by|obsoleted by)\s+$/i},
  {type: 'supersedes', re: /\b(?:in favor of|in favour of)\s+$/i},

  {type: 'revises', re: /\b(?:revises?|refines?|amends?)\s+$/i},

  // Active forms: source is derived from / extends / builds on target.
  {type: 'derived-from', re: /\bderived from\s+$/i},
  {type: 'derived-from', re: /\bbased on\s+$/i},
  {type: 'derived-from', re: /\bbuilds (?:on|upon)\s+$/i},
  {type: 'derived-from', re: /\bextends?\s+$/i},
  {type: 'derived-from', re: /\bextending\s+$/i},
  {type: 'derived-from', re: /\bfollows? from\s+$/i},
  {type: 'derived-from', re: /\binformed by\s+$/i},

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
  {type: 'supersedes', re: /^\s+(?:supersedes|replaces|obsoletes)\b/i},
  {type: 'revises', re: /^\s+(?:revises|refines|amends)\b/i},
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
  // Key: `${target}|${inverse ? 'I' : 'D'}`. Inverse and direct edges to the
  // same target coexist as separate entries — they're distinct edges in the DB.
  const byKey = new Map<string, {target: string; type: EdgeType; inverse: boolean}>();
  // Mask code regions so `[[ -z $x ]]` and `` `[[Page]]` `` don't surface as
  // wikilinks. Indices are preserved (replaced with same-length whitespace),
  // so the keyword windows still align with the original body for context.
  const masked = maskCodeRegions(body);

  for (const match of masked.matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim();
    if (!target) continue;
    if (target.startsWith('#')) continue;

    const at = match.index ?? 0;
    const before = body.slice(Math.max(0, at - WINDOW_BEFORE), at);
    const after = body.slice(at + match[0].length, at + match[0].length + WINDOW_AFTER);

    let type: EdgeType = 'cites';
    let inverse = false;
    for (const pat of PRE_PATTERNS) {
      if (pat.re.test(before)) {
        type = pat.type;
        inverse = pat.inverse === true;
        break;
      }
    }
    if (type === 'cites') {
      for (const pat of POST_PATTERNS) {
        if (pat.re.test(after)) {
          type = pat.type;
          inverse = pat.inverse === true;
          break;
        }
      }
    }

    const key = `${target}|${inverse ? 'I' : 'D'}`;
    const prior = byKey.get(key);
    if (prior === undefined || edgeRank(type) < edgeRank(prior.type)) {
      byKey.set(key, {target, type, inverse});
    }
  }

  return [...byKey.values()].map(({target, type, inverse}) =>
    inverse ? {target, type, inverse: true} : {target, type}
  );
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
