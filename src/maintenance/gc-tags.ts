// Delete taxonomy tags no record carries (D77).
//
// Nothing removed a taxonomy row before: a tag minted for a note outlived the
// note (the 2026-07-30/31 log expiry emptied several), and the five numeric
// tags from the 2026-04-29 seed were never used. A `manual` tag was created on
// purpose and waits for its notes, so it is kept at zero; `seeded` and
// `minted` tags are collected once they are older than the grace window, which
// covers a tag minted moments before the write that links it.
//
// A tag goes with its aliases (the FK cascades on update only) and with the
// pending `tag_suggestion` rows proposing it, rejected as `tag-deleted` so a
// sweep does not triage a tag that is gone.

import type {DatabaseSync} from 'node:sqlite';

export const DEFAULT_TAG_GRACE_DAYS = 1;
export const TAG_DELETED = 'tag-deleted';

export interface EmptyTag {
  tag: string;
  origin: string;
  added: string;
  description: boolean;
  aliases: string[];
}

export interface GcTagsSummary {
  dryRun: boolean;
  graceDays: number;
  /** Deleted, or under `dryRun` the tags that would be, A to Z. */
  tags: EmptyTag[];
  /** Empty automatic tags younger than the grace window, kept this pass. */
  young: EmptyTag[];
  /** Empty `manual` tags, kept by rule. */
  manual: number;
  deleted: number;
  suggestionsRejected: number;
  durationMs: number;
}

const MS_PER_DAY = 86_400_000;

export const gcTags = (
  db: DatabaseSync,
  opts: {dryRun?: boolean; graceDays?: number; now?: string} = {}
): GcTagsSummary => {
  const started = performance.now();
  const dryRun = opts.dryRun ?? false;
  const graceDays = opts.graceDays ?? DEFAULT_TAG_GRACE_DAYS;
  const now = opts.now ?? new Date().toISOString();
  const cutoff = Date.parse(now) - graceDays * MS_PER_DAY;

  const rows = db
    .prepare(
      `SELECT t.tag AS tag, t.origin AS origin, t.added AS added,
              t.description IS NOT NULL AS described
         FROM tags_taxonomy t
        WHERE NOT EXISTS (SELECT 1 FROM tags WHERE tags.tag = t.tag)
        ORDER BY t.tag`
    )
    .all() as unknown[] as {tag: string; origin: string; added: string; described: number}[];
  const aliasesOf = db.prepare('SELECT alias FROM tag_aliases WHERE canonical = ? ORDER BY alias');

  const tags: EmptyTag[] = [];
  const young: EmptyTag[] = [];
  let manual = 0;
  for (const row of rows) {
    if (row.origin === 'manual') {
      ++manual;
      continue;
    }
    const entry: EmptyTag = {
      tag: row.tag,
      origin: row.origin,
      added: row.added,
      description: row.described === 1,
      aliases: (aliasesOf.all(row.tag) as {alias: string}[]).map(a => a.alias)
    };
    (Date.parse(row.added) < cutoff ? tags : young).push(entry);
  }

  let suggestionsRejected = 0;
  if (!dryRun && tags.length) {
    const dropAliases = db.prepare('DELETE FROM tag_aliases WHERE canonical = ?');
    const rejectSuggestions = db.prepare(
      `UPDATE suggestions
          SET status = 'rejected', resolved_at = ?, resolved_by = '${TAG_DELETED}',
              claimed_by = NULL, claimed_at = NULL, claim_expires = NULL, claim_token = NULL
        WHERE kind = 'tag_suggestion' AND status IN ('pending', 'claimed')
          AND json_extract(payload, '$.tag') = ?`
    );
    const dropTag = db.prepare('DELETE FROM tags_taxonomy WHERE tag = ?');
    db.exec('BEGIN');
    try {
      for (const {tag} of tags) {
        dropAliases.run(tag);
        suggestionsRejected += Number(rejectSuggestions.run(now, tag).changes);
        dropTag.run(tag);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    dryRun,
    graceDays,
    tags,
    young,
    manual,
    deleted: dryRun ? 0 : tags.length,
    suggestionsRejected,
    durationMs: Math.round(performance.now() - started)
  };
};
