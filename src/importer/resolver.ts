import type {VaultRecord} from '../records/types.ts';

/**
 * Resolve wikilink target text to a record_id. Three resolution strategies, in order:
 *
 *   1. Exact path match: `[[topics/foo]]` ↔ `topics/foo.md`.
 *   2. Exact path match without trailing `.md` typed by the link.
 *   3. Basename uniqueness: `[[foo]]` resolves only if exactly one record's filename
 *      basename (without `.md`) is `foo`. Ambiguous basenames return null.
 *
 * Built once per build-edges pass over a static record set; cheap to construct.
 */
export class WikilinkResolver {
  readonly #byPath: Map<string, string> = new Map();
  readonly #byBasename: Map<string, string[]> = new Map();

  constructor(records: Iterable<VaultRecord>) {
    for (const r of records) {
      this.#byPath.set(r.filePath, r.recordId);
      const noMd = r.filePath.replace(/\.md$/, '');
      if (noMd !== r.filePath) this.#byPath.set(noMd, r.recordId);

      const basename = noMd.split('/').pop() ?? noMd;
      const list = this.#byBasename.get(basename) ?? [];
      list.push(r.recordId);
      this.#byBasename.set(basename, list);
    }
  }

  /** Returns the record_id of the resolved target, or null when unresolvable. */
  resolve(linkText: string): string | null {
    const text = linkText.trim();
    if (!text) return null;

    const exact = this.#byPath.get(text);
    if (exact) return exact;

    const withMd = this.#byPath.get(`${text}.md`);
    if (withMd) return withMd;

    const noMd = text.replace(/\.md$/, '');
    const basename = noMd.split('/').pop() ?? noMd;
    if (basename !== noMd) return null; // path-shaped link with prefix; already tried above

    const candidates = this.#byBasename.get(basename);
    if (candidates && candidates.length === 1) return candidates[0] ?? null;
    return null;
  }
}
