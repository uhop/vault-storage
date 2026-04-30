// Filing logic for indexer-driven suggestions.
//
// `edge_type` — body-wikilink classifier defaults un-cued links to `cites`;
// each unreviewed default-cites is filed for agent review. Resolution lives
// in the source record's frontmatter `edges:` map; build-edges applies the
// override on next reindex and auto-accepts the matching pending suggestion.
//
// `new_tag` — TagsImporter rejects unknown tags (not in `tags_taxonomy` and
// not aliased). Each `(record, tag)` rejection files a pending suggestion.
// Resolution is via POST /tags/taxonomy (add canonical) or POST /tags/aliases
// (add as alias of an existing canonical), which the skill drives.
//
// Both filers idempotent: a suggestion of any status for the same key (pair
// for edges, tag+record for tags) blocks re-filing. Re-imports of unchanged
// content produce no new suggestions.

import type {DatabaseSync, StatementSync} from 'node:sqlite';
import {uuidv7} from '../util/uuid.ts';

export interface EdgeSuggestionPayload {
  from_record: string;
  from_path: string;
  to_record: string;
  to_path: string;
  classifier_type: 'cites';
  context: string;
}

export class EdgeSuggestionFiler {
  readonly #findExisting: StatementSync;
  readonly #insert: StatementSync;
  readonly #autoAcceptPending: StatementSync;

  constructor(db: DatabaseSync) {
    this.#findExisting = db.prepare(
      `SELECT id FROM suggestions
       WHERE kind = 'edge_type'
         AND json_extract(payload, '$.from_record') = ?
         AND json_extract(payload, '$.to_record') = ?
       LIMIT 1`
    );
    this.#insert = db.prepare(
      `INSERT INTO suggestions (id, kind, subject_id, payload, status, created)
       VALUES (?, 'edge_type', ?, ?, 'pending', ?)`
    );
    this.#autoAcceptPending = db.prepare(
      `UPDATE suggestions
          SET status = 'accepted',
              resolved_at = ?,
              resolved_by = 'fm-override'
        WHERE kind = 'edge_type'
          AND status = 'pending'
          AND json_extract(payload, '$.from_record') = ?
          AND json_extract(payload, '$.to_record') = ?`
    );
  }

  /**
   * File a pending `edge_type` suggestion if no suggestion of any status
   * already exists for the same `(from_record, to_record)` pair.
   *
   * Returns `true` if a suggestion was filed, `false` if skipped (a prior
   * suggestion exists — pending, accepted, or rejected). Caller can sum the
   * `true` returns to report `suggestionsFiled` in build summaries.
   */
  fileEdgeTypeSuggestion(args: {
    fromRecordId: string;
    fromPath: string;
    toRecordId: string;
    toPath: string;
    context: string;
    now: string;
  }): boolean {
    const existing = this.#findExisting.get(args.fromRecordId, args.toRecordId);
    if (existing) return false;
    const payload: EdgeSuggestionPayload = {
      from_record: args.fromRecordId,
      from_path: args.fromPath,
      to_record: args.toRecordId,
      to_path: args.toPath,
      classifier_type: 'cites',
      context: args.context
    };
    this.#insert.run(uuidv7(), args.fromRecordId, JSON.stringify(payload), args.now);
    return true;
  }

  /**
   * When build-edges applies an FM `edges:` override and finds a pending
   * suggestion for the same pair (e.g., the user edited frontmatter manually
   * after the suggestion was filed), auto-resolve the suggestion to accepted
   * with `resolved_by='fm-override'`. Returns true if a pending suggestion
   * was promoted to accepted.
   */
  autoAcceptOnFmOverride(fromRecordId: string, toRecordId: string, now: string): boolean {
    return this.#autoAcceptPending.run(now, fromRecordId, toRecordId).changes > 0;
  }
}

export interface NewTagSuggestionPayload {
  tag: string;
  record_id: string;
  file_path: string;
}

export class TagSuggestionFiler {
  readonly #findExisting: StatementSync;
  readonly #insert: StatementSync;
  readonly #autoAcceptByTag: StatementSync;

  constructor(db: DatabaseSync) {
    this.#findExisting = db.prepare(
      `SELECT id FROM suggestions
       WHERE kind = 'new_tag'
         AND json_extract(payload, '$.tag') = ?
         AND json_extract(payload, '$.record_id') = ?
       LIMIT 1`
    );
    this.#insert = db.prepare(
      `INSERT INTO suggestions (id, kind, subject_id, payload, status, created)
       VALUES (?, 'new_tag', ?, ?, 'pending', ?)`
    );
    this.#autoAcceptByTag = db.prepare(
      `UPDATE suggestions
          SET status = 'accepted',
              resolved_at = ?,
              resolved_by = ?
        WHERE kind = 'new_tag'
          AND status = 'pending'
          AND json_extract(payload, '$.tag') = ?`
    );
  }

  /**
   * File a pending `new_tag` suggestion for an unknown-tag rejection. One
   * suggestion per `(tag, record_id)` pair — the agent sees N suggestions
   * for the same tag if it appears on N records, and resolves them as a
   * group when adding the tag to the taxonomy.
   *
   * Returns true if a suggestion was filed; false if a prior suggestion
   * (any status) already covers this pair.
   */
  fileNewTagSuggestion(args: {
    recordId: string;
    filePath: string;
    tag: string;
    now: string;
  }): boolean {
    const existing = this.#findExisting.get(args.tag, args.recordId);
    if (existing) return false;
    const payload: NewTagSuggestionPayload = {
      tag: args.tag,
      record_id: args.recordId,
      file_path: args.filePath
    };
    this.#insert.run(uuidv7(), args.recordId, JSON.stringify(payload), args.now);
    return true;
  }

  /**
   * When a tag is added to `tags_taxonomy` (canonical) or `tag_aliases`
   * (alias → existing canonical), all pending `new_tag` suggestions for that
   * tag are now resolved. Auto-accept them with `resolved_by` indicating
   * which path was taken. Returns the count of suggestions promoted.
   */
  autoAcceptByTag(tag: string, resolvedBy: 'taxonomy-add' | 'alias-add', now: string): number {
    return Number(this.#autoAcceptByTag.run(now, resolvedBy, tag).changes);
  }
}
