// Tag canonicalization for migration. Collects raw tags across the vault,
// normalizes, detects singular/plural pairs, and emits:
//   - canonical: the seed list for `tags_taxonomy`
//   - aliases:   the seed list for `tag_aliases` (raw → canonical)
//
// Rules from design/closed-enums.md § Tag conventions:
//   - lowercase
//   - kebab-case (`_` and whitespace → `-`)
//   - ASCII-only (drops accents and unrelated punctuation)
//   - singular preferred (`gotchas` → `gotcha` when `gotcha` also appears)
//
// "Detect plural" is conservative: only when both forms (singular and one of
// `+s`, `+es`, `+ies`) appear in the source corpus — never speculatively
// strip a trailing `s` from a tag that has no observed singular partner. This
// avoids damage to tags like `aws` that look plural but aren't.

const NON_TAG_CHAR = /[^a-z0-9-]+/g;

/** Lowercase + kebab-case + drop non-[a-z0-9-]; collapse repeated dashes; trim leading/trailing dash. */
export const normalizeTag = (raw: string): string =>
  raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(NON_TAG_CHAR, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

interface DepluralCandidate {
  /** The plural form actually seen in the corpus. */
  plural: string;
  /** Singular candidate derived from the plural (rule applied). */
  singular: string;
}

const dePluralCandidates = (tag: string): string[] => {
  const out: string[] = [];
  if (tag.endsWith('ies') && tag.length > 4) out.push(tag.slice(0, -3) + 'y');
  if (tag.endsWith('es') && tag.length > 3) out.push(tag.slice(0, -2));
  if (tag.endsWith('s') && tag.length > 2) out.push(tag.slice(0, -1));
  return out;
};

export interface TagMap {
  /** Canonical tag set; this seeds tags_taxonomy. */
  canonical: Set<string>;
  /** raw → canonical aliases. seeds tag_aliases. */
  aliases: Map<string, string>;
  /** Plural-form rewrites detected during the pass (for the migration report). */
  pluralCollapses: DepluralCandidate[];
}

/**
 * Build the canonical-tag and alias maps from raw tag occurrences.
 *
 * The algorithm:
 *  1. Normalize each raw tag (lowercase, kebab-case, ASCII-only).
 *  2. If the normalized form differs from the raw, record the alias.
 *  3. Collect the normalized set.
 *  4. For each normalized tag with a plural-suffix shape, check whether its
 *     singular sibling is also present; if yes, redirect plural → singular
 *     (canonical drops the plural; alias plural → singular is added).
 *
 * Result: canonical contains only "leaf" tags after deduplication; aliases
 * map every raw and intermediate form to its canonical destination.
 */
export const buildTagMap = (rawTags: Iterable<string>): TagMap => {
  const aliases = new Map<string, string>();
  const normalized = new Set<string>();

  for (const raw of rawTags) {
    const norm = normalizeTag(raw);
    if (norm.length === 0) continue;
    normalized.add(norm);
    if (raw !== norm) aliases.set(raw, norm);
  }

  const pluralCollapses: DepluralCandidate[] = [];
  const canonical = new Set(normalized);

  for (const tag of normalized) {
    for (const candidate of dePluralCandidates(tag)) {
      if (normalized.has(candidate)) {
        pluralCollapses.push({plural: tag, singular: candidate});
        canonical.delete(tag);
        aliases.set(tag, candidate);
        // Redirect any earlier alias that pointed at the plural form.
        for (const [k, v] of aliases.entries()) {
          if (v === tag) aliases.set(k, candidate);
        }
        break;
      }
    }
  }

  return {canonical, aliases, pluralCollapses};
};

/** Resolve a raw tag to its canonical form via the alias map; falls back to the normalized form. */
export const canonicalizeTag = (raw: string, map: TagMap): string => {
  const norm = normalizeTag(raw);
  return map.aliases.get(raw) ?? map.aliases.get(norm) ?? norm;
};
