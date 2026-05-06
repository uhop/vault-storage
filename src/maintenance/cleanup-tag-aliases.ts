import type {DatabaseSync} from 'node:sqlite';

export interface CleanupTagAliasesSummary {
  requested: number;
  deleted: string[];
  missing: string[];
  notDangling: string[];
  durationMs: number;
}

/**
 * Delete dangling `tag_aliases` rows by explicit name list. An alias is
 * "dangling" when its `canonical` value has no matching row in
 * `tags_taxonomy` — usually a residue of a canonical-tag deletion that
 * happened with foreign_keys off, or a direct DB edit.
 *
 * The `aliases` argument is required and explicit: no "delete every
 * dangling row" mode. Aliases were authored by a human and may carry
 * intent the system can't reconstruct from the dangling row alone, so
 * the operator picks the ones to drop. Each alias is validated before
 * deletion:
 *
 * - `missing`: not present in `tag_aliases` at all
 * - `notDangling`: present but its `canonical` exists in `tags_taxonomy`
 *   (deleting it would lose user intent)
 * - `deleted`: present and dangling (DELETE applied)
 *
 * The three buckets are disjoint and cover every input alias.
 * Idempotent: a second call with the same list deletes nothing and
 * returns all aliases under `missing`.
 */
export const cleanupTagAliases = (
  db: DatabaseSync,
  aliases: readonly string[]
): CleanupTagAliasesSummary => {
  const start = Date.now();
  const deleted: string[] = [];
  const missing: string[] = [];
  const notDangling: string[] = [];

  const checkAlias = db.prepare(
    `SELECT a.alias, a.canonical,
            EXISTS (SELECT 1 FROM tags_taxonomy t WHERE t.tag = a.canonical) AS canonical_exists
       FROM tag_aliases a
      WHERE a.alias = ?`
  );
  const deleteAlias = db.prepare(`DELETE FROM tag_aliases WHERE alias = ?`);

  for (const alias of aliases) {
    const row = checkAlias.get(alias) as
      | {alias: string; canonical: string; canonical_exists: number}
      | undefined;
    if (row === undefined) {
      missing.push(alias);
      continue;
    }
    if (row.canonical_exists !== 0) {
      notDangling.push(alias);
      continue;
    }
    deleteAlias.run(alias);
    deleted.push(alias);
  }

  return {
    requested: aliases.length,
    deleted,
    missing,
    notDangling,
    durationMs: Date.now() - start
  };
};
