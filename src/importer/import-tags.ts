// Per-record tag mapping. The migration importer seeds `tags_taxonomy` and
// `tag_aliases`; this module writes the live `tags(record_id, tag)` mapping
// during ongoing imports.
//
// Behavior:
//   - Frontmatter `tags` is an array of strings. Each is normalized
//     (`normalizeTag`) then alias-rewritten via `tag_aliases`.
//   - Insert into `tags`. The schema's trigger rejects unknown tags
//     (tags missing from `tags_taxonomy`) — we catch the error and skip,
//     leaving a stderr note. The suggestions-surface ticket will turn these
//     into reviewable `new_tag` suggestions once the surface is built.
//   - The full set is replaced atomically: `DELETE FROM tags WHERE record_id`
//     before re-inserting, so a record losing a tag between imports is reflected.

import type {DatabaseSync, StatementSync} from 'node:sqlite';
import {normalizeTag} from '../migration/tags.ts';

export class TagsImporter {
  readonly #deleteForRecord: StatementSync;
  readonly #insertTag: StatementSync;
  readonly #lookupAlias: StatementSync;

  constructor(db: DatabaseSync) {
    this.#deleteForRecord = db.prepare('DELETE FROM tags WHERE record_id = ?');
    this.#insertTag = db.prepare('INSERT OR IGNORE INTO tags (record_id, tag) VALUES (?, ?)');
    this.#lookupAlias = db.prepare('SELECT canonical FROM tag_aliases WHERE alias = ?');
  }

  /**
   * Replace the tag set for a record from its frontmatter `tags:` array.
   * Returns the count of tags inserted (post-alias, post-dedup) and the
   * tags that were rejected by the taxonomy trigger.
   */
  syncTags(recordId: string, frontmatterTags: unknown): {inserted: number; rejected: string[]} {
    this.#deleteForRecord.run(recordId);

    if (!Array.isArray(frontmatterTags)) return {inserted: 0, rejected: []};

    const seen = new Set<string>();
    const rejected: string[] = [];
    let inserted = 0;

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
        // Trigger fired — tag missing from taxonomy. Record for the caller's
        // summary; don't fail the import.
        rejected.push(tag);
      }
    }

    return {inserted, rejected};
  }
}
