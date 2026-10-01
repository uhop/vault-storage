// Obsidian-style wikilink parsing. Format: `[[target]]` or `[[target|display]]`.
// Targets may include forward slashes (`[[topics/foo]]`) and may end in `.md`
// (or omit it). The display segment is dropped.
//
// Code-block masking strips fenced and inline code regions before scanning so
// shell `[[ $x == y ]]` tests, awk `[[:cntrl:]]` character classes, and
// documentation backtick spans like `` `[[Page]]` `` don't surface as wikilinks.
//
// Pure-anchor links (`[[#heading]]`) are dropped — they're same-document
// anchors, not cross-record references.

const WIKILINK_RE = /\[\[([^\]\n|[]+?)(?:\|[^\]]*)?\]\]/g;
const FENCE_LINE_RE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const INLINE_CODE_RE = /`+[^`\n]+?`+/g;

const blank = (s: string): string => s.replace(/[^\n]/g, ' ');

// INLINE_CODE_RE spans no newline.
const blankLine = (s: string): string => ' '.repeat(s.length);

/** Texts this long keep their masks, up to this many characters in all (D125). */
const MEMO_MIN_LENGTH = 16_384;
const MEMO_CHARS = 4_000_000;
const memo = new Map<string, string>();
let memoChars = 0;

/**
 * Fenced code blocks as `[start, end)` offsets. CommonMark § 4.5: a fence
 * closes only on a line of the same character, at least as long as the
 * opener, so a four-backtick block can hold three-backtick ones. A backtick
 * opener's info string has no backtick. An unclosed fence masks nothing.
 */
const fencedRanges = (text: string): [number, number][] => {
  const ranges: [number, number][] = [];
  let open: {start: number; char: string; length: number} | null = null;
  let pos = 0;
  for (const line of text.split('\n')) {
    const m = FENCE_LINE_RE.exec(line);
    if (m) {
      const run = m[1]!;
      const rest = m[2]!;
      if (open === null) {
        if (run[0] === '~' || !rest.includes('`')) {
          open = {start: pos, char: run[0]!, length: run.length};
        }
      } else if (run[0] === open.char && run.length >= open.length && rest.trim() === '') {
        ranges.push([open.start, pos + line.length]);
        open = null;
      }
    }
    pos += line.length + 1;
  }
  return ranges;
};

const mask = (text: string): string => {
  let masked = '';
  let from = 0;
  for (const [start, end] of fencedRanges(text)) {
    masked += text.slice(from, start) + blank(text.slice(start, end));
    from = end;
  }
  masked += text.slice(from);
  return masked.replace(INLINE_CODE_RE, blankLine);
};

/**
 * Replace fenced code blocks and inline code spans with whitespace of the same
 * length. Indices are preserved so callers using `match.index` for context
 * windows still align with the original text. The masks of the most recent
 * long texts are kept, so the repeats of one write are lookups (D125).
 */
export const maskCodeRegions = (text: string): string => {
  if (text.length < MEMO_MIN_LENGTH || text.length > MEMO_CHARS) return mask(text);
  let masked = memo.get(text);
  if (masked === undefined) {
    masked = mask(text);
    memoChars += text.length;
    for (const kept of memo.keys()) {
      if (memoChars <= MEMO_CHARS) break;
      memo.delete(kept);
      memoChars -= kept.length;
    }
  } else {
    memo.delete(text);
  }
  memo.set(text, masked);
  return masked;
};

/** Pull every wikilink target out of arbitrary text. Display segments are dropped. */
export const extractWikilinks = (text: string): string[] => {
  const masked = maskCodeRegions(text);
  const out: string[] = [];
  for (const match of masked.matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim();
    if (!target) continue;
    if (target.startsWith('#')) continue;
    out.push(target);
  }
  return out;
};

/**
 * Read the `related:` field from frontmatter (an array of `"[[target]]"` strings,
 * per vault convention) and return the resolved target list.
 */
export const extractRelatedFromFrontmatter = (data: {[key: string]: unknown}): string[] => {
  const related = data['related'];
  if (!Array.isArray(related)) return [];
  const out: string[] = [];
  for (const item of related) {
    if (typeof item !== 'string') continue;
    out.push(...extractWikilinks(item));
  }
  return out;
};

/**
 * Read the `edges:` map from frontmatter — a per-record override for the
 * body-wikilink classifier. Each entry is `<target>: <edge-type>`, where
 * `<target>` is a wikilink target as written in the body (slug or path form,
 * e.g. `topics/foo` or `foo`) and `<edge-type>` is a caller-accepted declared
 * type — canonical `EDGE_TYPES`, plus `EDGE_TYPE_ALIASES` (`basis-for`) when
 * the caller includes them in `validTypes`.
 *
 * Used by build-edges to override the classifier's default `cites` for
 * ambiguous body wikilinks. An explicit `target: cites` entry is meaningful —
 * it marks "reviewed, cites is correct", distinct from no-entry (= unreviewed).
 *
 * Invalid entries (unknown edge types, non-string values) are skipped; the
 * parser is permissive so a typo doesn't crash the indexer. The skipped
 * string types are reported through `dropped`, so the edge pass can record
 * them (D103).
 */
export const extractEdgesFromFrontmatter = (
  data: {[key: string]: unknown},
  validTypes: ReadonlySet<string>,
  dropped?: (target: string, type: string) => void
): Map<string, string> => {
  const out = new Map<string, string>();
  const raw = data['edges'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [target, type] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof type !== 'string') continue;
    if (!validTypes.has(type)) {
      dropped?.(target, type);
      continue;
    }
    out.set(target, type);
  }
  return out;
};
