import type {VaultRecord} from '../records/types.ts';

/**
 * Resolve wikilink target text to a record_id. Resolution strategies, in order:
 *
 *   1. Exact path match: `[[topics/foo]]` ↔ `topics/foo.md`.
 *   2. Exact path match without trailing `.md` typed by the link.
 *   3. Basename uniqueness: `[[foo]]` resolves only if exactly one record's filename
 *      basename (without `.md`) is `foo`. Ambiguous basenames return null.
 *   4. Folder fallback: `[[projects/blog/decisions]]` redirects to the folder's
 *      `_about.md` if one exists. Atomization replaces a `decisions.md` file
 *      with a `decisions/` folder of pieces; this keeps the old wikilinks
 *      resolving (to the folder-level "what is this" doc).
 *
 * Built once per build-edges pass over a static record set; cheap to construct.
 */
export class WikilinkResolver {
  readonly #byPath: Map<string, string> = new Map();
  readonly #byBasename: Map<string, string[]> = new Map();
  readonly #byFolder: Map<string, string> = new Map();

  constructor(records: Iterable<VaultRecord>) {
    for (const r of records) {
      this.#byPath.set(r.filePath, r.recordId);
      const noMd = r.filePath.replace(/\.md$/, '');
      if (noMd !== r.filePath) this.#byPath.set(noMd, r.recordId);

      const basename = noMd.split('/').pop() ?? noMd;
      const list = this.#byBasename.get(basename) ?? [];
      list.push(r.recordId);
      this.#byBasename.set(basename, list);

      // Index folder → _about.md so old wikilinks at the file level still
      // resolve after atomization splits the file into a folder of pieces.
      if (r.filePath.endsWith('/_about.md')) {
        const folder = r.filePath.slice(0, -'/_about.md'.length);
        this.#byFolder.set(folder, r.recordId);
      }
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

    if (basename === noMd) {
      const candidates = this.#byBasename.get(basename);
      if (candidates && candidates.length === 1) return candidates[0] ?? null;
    }

    // Folder fallback (handles atomization redirects).
    const folderHit = this.#byFolder.get(text) ?? this.#byFolder.get(noMd);
    if (folderHit) return folderHit;

    return null;
  }
}
