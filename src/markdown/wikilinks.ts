// Obsidian-style wikilink parsing. Format: `[[target]]` or `[[target|display]]`.
// Targets may include forward slashes (`[[topics/foo]]`) and may end in `.md`
// (or omit it). The display segment is dropped.

const WIKILINK_RE = /\[\[([^\]\n|[]+?)(?:\|[^\]]*)?\]\]/g;

/** Pull every wikilink target out of arbitrary text. Display segments are dropped. */
export const extractWikilinks = (text: string): string[] => {
  const out: string[] = [];
  for (const match of text.matchAll(WIKILINK_RE)) {
    const target = match[1]?.trim();
    if (target) out.push(target);
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
