import type {DatabaseSync} from 'node:sqlite';
import type {TagMap} from './tags.ts';

/**
 * Seed `tags_taxonomy` (canonical tag list) and `tag_aliases` (raw → canonical
 * map). Idempotent — INSERT OR IGNORE on both, so re-runs don't error.
 */
export const seedTagsTaxonomy = (db: DatabaseSync, tagMap: TagMap, isoDate: string): void => {
  const insertCanonical = db.prepare(
    `INSERT OR IGNORE INTO tags_taxonomy (tag, description, added) VALUES (?, NULL, ?)`
  );
  const insertAlias = db.prepare(
    `INSERT OR IGNORE INTO tag_aliases (alias, canonical) VALUES (?, ?)`
  );

  db.exec('BEGIN');
  try {
    for (const tag of tagMap.canonical) {
      insertCanonical.run(tag, isoDate);
    }
    for (const [raw, canonical] of tagMap.aliases) {
      // Only seed aliases whose canonical exists in the taxonomy. The plural
      // collapses pre-empt the original normalized form, so all valid alias
      // targets are present in `canonical` by construction.
      if (tagMap.canonical.has(canonical)) {
        insertAlias.run(raw, canonical);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};
