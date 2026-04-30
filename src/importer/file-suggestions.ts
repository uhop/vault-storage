// Filing logic for `edge_type` suggestions. The body-wikilink classifier
// auto-promotes keyword-cued links (e.g., "supersedes [[X]]" → `supersedes`);
// links it can't classify default to `cites`. Default-cites are candidates
// for agent review — they may genuinely be `cites`, or the user may want to
// promote them to `derived-from`, `applies-to`, etc.
//
// This filer logs each unreviewed default-cites edge as a pending `edge_type`
// suggestion. The agent reviews via `/vault-review-edges`, writes the chosen
// type into the source record's frontmatter `edges:` map, and marks the
// suggestion accepted/rejected. On the next reindex, build-edges reads the
// FM `edges:` and overrides the classifier's `cites` default — the markdown
// file is the source of truth (per design constraint C4).
//
// Idempotency: a suggestion is filed only when no suggestion of any status
// already exists for the same `(from_record, to_record)` pair. Re-imports of
// the same content produce no new suggestions.

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
