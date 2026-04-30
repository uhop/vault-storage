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
const FENCED_CODE_RE = /(^|\n)([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?\n\2\3[ \t]*(?=\n|$)/g;
const INLINE_CODE_RE = /`+[^`\n]+?`+/g;

/**
 * Replace fenced code blocks and inline code spans with whitespace of the same
 * length. Indices are preserved so callers using `match.index` for context
 * windows still align with the original text.
 */
export const maskCodeRegions = (text: string): string => {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  let masked = text.replace(FENCED_CODE_RE, blank);
  masked = masked.replace(INLINE_CODE_RE, blank);
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
 * e.g. `topics/foo` or `foo`) and `<edge-type>` is one of the canonical edge
 * types from `EDGE_TYPES`.
 *
 * Used by build-edges to override the classifier's default `cites` for
 * ambiguous body wikilinks. An explicit `target: cites` entry is meaningful —
 * it marks "reviewed, cites is correct", distinct from no-entry (= unreviewed).
 *
 * Invalid entries (unknown edge types, non-string values) are silently
 * skipped; the parser is permissive so a typo doesn't crash the indexer.
 */
export const extractEdgesFromFrontmatter = (
  data: {[key: string]: unknown},
  validTypes: ReadonlySet<string>
): Map<string, string> => {
  const out = new Map<string, string>();
  const raw = data['edges'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [target, type] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof type !== 'string') continue;
    if (!validTypes.has(type)) continue;
    out.set(target, type);
  }
  return out;
};
