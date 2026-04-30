// Per-record tag mapping. The migration importer seeds `tags_taxonomy` and
// `tag_aliases`; this module writes the live `tags(record_id, tag)` mapping
// during ongoing imports.
//
// Behavior:
//   - Frontmatter `tags` is an array of strings. Each is normalized
//     (`normalizeTag`) then alias-rewritten via `tag_aliases`.
//   - Insert into `tags`. The schema's trigger rejects unknown tags
//     (tags missing from `tags_taxonomy`) — we catch the error and file a
//     pending `new_tag` suggestion for agent review (per design constraint
//     C16). The agent decides via `/vault-review-tags` whether to add the
//     tag to the taxonomy, register it as an alias of an existing canonical,
//     or treat it as a typo and remove it from the source FM.
//   - The full set is replaced atomically: `DELETE FROM tags WHERE record_id`
//     before re-inserting, so a record losing a tag between imports is reflected.

import type {DatabaseSync, StatementSync} from 'node:sqlite';
import {normalizeTag} from '../migration/tags.ts';
import {TagSuggestionFiler} from './file-suggestions.ts';

export class TagsImporter {
  readonly #deleteForRecord: StatementSync;
  readonly #insertTag: StatementSync;
  readonly #lookupAlias: StatementSync;
  readonly #filer: TagSuggestionFiler;

  constructor(db: DatabaseSync) {
    this.#deleteForRecord = db.prepare('DELETE FROM tags WHERE record_id = ?');
    this.#insertTag = db.prepare('INSERT OR IGNORE INTO tags (record_id, tag) VALUES (?, ?)');
    this.#lookupAlias = db.prepare('SELECT canonical FROM tag_aliases WHERE alias = ?');
    this.#filer = new TagSuggestionFiler(db);
  }

  /**
   * Replace the tag set for a record from its frontmatter `tags:` array.
   * Returns the count of tags inserted (post-alias, post-dedup), the tags
   * rejected by the taxonomy trigger, and the count of new_tag suggestions
   * filed (idempotent — re-imports of the same record file no new ones).
   */
  syncTags(
    recordId: string,
    filePath: string,
    frontmatterTags: unknown,
    now?: string
  ): {inserted: number; rejected: string[]; suggestionsFiled: number} {
    this.#deleteForRecord.run(recordId);

    if (!Array.isArray(frontmatterTags)) {
      return {inserted: 0, rejected: [], suggestionsFiled: 0};
    }

    const stamp = now ?? new Date().toISOString();
    const seen = new Set<string>();
    const rejected: string[] = [];
    let inserted = 0;
    let suggestionsFiled = 0;

    for (const raw of frontmatterTags) {
      if (typeof raw !== 'string') continue;
      const norm = normalizeTag(raw);
      if (norm.length === 0) continue;

      const aliasRow = this.#lookupAlias.get(norm) as {canonical: string} | undefined;
      const tag = aliasRow?.canonical ?? norm;

      if (seen.has(tag)) continue;
      seen.add(tag);

      try {
        this.#insertTag.run(recordId, tag);
        inserted++;
      } catch (err) {
        // Trigger fired — tag missing from taxonomy. File a `new_tag`
        // suggestion (idempotent; same record+tag won't re-file) and
        // include the rejected tag in the caller's summary.
        rejected.push(tag);
        const filed = this.#filer.fileNewTagSuggestion({
          recordId,
          filePath,
          tag,
          now: stamp
        });
        if (filed) suggestionsFiled++;
      }
    }

    return {inserted, rejected, suggestionsFiled};
  }
}
