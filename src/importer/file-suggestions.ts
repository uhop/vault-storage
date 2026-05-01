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
// `tag_suggestion` — agent-judged additions from `agent.tags_suggested`.
// Distinct from `new_tag`: the tag is *not yet* on the record's FM `tags:`,
// the agent thinks it should be. Resolution = the user adds the tag to FM,
// reimport detects it now-realized, auto-accepts. Or user rejects.
//
// All filers idempotent on a kind-specific key. Re-imports of unchanged
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

export class NewTagSuggestionFiler {
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

export interface TagSuggestionPayload {
  tag: string;
  record_id: string;
  file_path: string;
}

/**
 * `tag_suggestion` — agent-judged tag additions from `agent.tags_suggested`.
 * The tag is NOT (yet) on the record's FM `tags:`; the agent thinks it
 * should be. Distinct from `new_tag` (which is fired when an unknown tag
 * IS on FM but isn't in the taxonomy).
 *
 * Idempotent on `(record_id, tag, status='pending')`. Auto-resolves to
 * `accepted` with `resolved_by='tag-realized'` on the next import where
 * the tag is now in the record's `tags` table — i.e., the user (or an
 * agent) added the tag to FM and the importer accepted it.
 */
export class TagSuggestionFiler {
  readonly #findExisting: StatementSync;
  readonly #insert: StatementSync;
  readonly #autoAcceptForRecordTag: StatementSync;

  constructor(db: DatabaseSync) {
    this.#findExisting = db.prepare(
      `SELECT id FROM suggestions
       WHERE kind = 'tag_suggestion'
         AND status = 'pending'
         AND json_extract(payload, '$.tag') = ?
         AND json_extract(payload, '$.record_id') = ?
       LIMIT 1`
    );
    this.#insert = db.prepare(
      `INSERT INTO suggestions (id, kind, subject_id, payload, status, created)
       VALUES (?, 'tag_suggestion', ?, ?, 'pending', ?)`
    );
    this.#autoAcceptForRecordTag = db.prepare(
      `UPDATE suggestions
          SET status = 'accepted',
              resolved_at = ?,
              resolved_by = 'tag-realized'
        WHERE kind = 'tag_suggestion'
          AND status = 'pending'
          AND json_extract(payload, '$.record_id') = ?
          AND json_extract(payload, '$.tag') = ?`
    );
  }

  /**
   * File a pending `tag_suggestion` for `(record, tag)`. Idempotent on the
   * pending row — accepted/rejected entries don't block re-filing, so a
   * suggestion that was rejected can later be re-suggested (e.g., the body
   * changed, the agent re-suggests).
   *
   * Returns true if filed; false if a pending suggestion already exists.
   */
  fileTagSuggestion(args: {
    recordId: string;
    filePath: string;
    tag: string;
    now: string;
  }): boolean {
    const existing = this.#findExisting.get(args.tag, args.recordId);
    if (existing) return false;
    const payload: TagSuggestionPayload = {
      tag: args.tag,
      record_id: args.recordId,
      file_path: args.filePath
    };
    this.#insert.run(uuidv7(), args.recordId, JSON.stringify(payload), args.now);
    return true;
  }

  /**
   * Auto-accept any pending `tag_suggestion` for `(record, tag)` when the
   * tag now appears on the record's actual tag set (via FM edit + reimport).
   * Returns true if a pending suggestion was promoted.
   */
  autoAcceptForRecordTag(recordId: string, tag: string, now: string): boolean {
    return this.#autoAcceptForRecordTag.run(now, recordId, tag).changes > 0;
  }
}

export interface DuplicateSuggestionPayload {
  /** Record IDs in canonical (sorted) order so the pair-key is symmetric. */
  a_record: string;
  a_path: string;
  b_record: string;
  b_path: string;
  /** Cosine distance — 0 = identical, 1 = orthogonal, 2 = opposite. */
  distance: number;
}

export class DuplicateSuggestionFiler {
  readonly #findExisting: StatementSync;
  readonly #insert: StatementSync;

  constructor(db: DatabaseSync) {
    // Match either ordering of the pair (the maintenance scan canonicalizes,
    // but defensive matching keeps idempotency intact across schema/scan changes).
    this.#findExisting = db.prepare(
      `SELECT id FROM suggestions
       WHERE kind = 'duplicate'
         AND (
           (json_extract(payload, '$.a_record') = ? AND json_extract(payload, '$.b_record') = ?) OR
           (json_extract(payload, '$.a_record') = ? AND json_extract(payload, '$.b_record') = ?)
         )
       LIMIT 1`
    );
    this.#insert = db.prepare(
      `INSERT INTO suggestions (id, kind, subject_id, payload, status, created)
       VALUES (?, 'duplicate', ?, ?, 'pending', ?)`
    );
  }

  /**
   * File a pending `duplicate` suggestion for a high-similarity record pair.
   * Idempotent on the unordered pair `{a_record, b_record}`. Returns true if
   * filed; false if a prior suggestion (any status) already covers the pair.
   *
   * Caller is responsible for canonicalizing the pair (lower record_id first)
   * before calling — the payload reflects whatever order is passed.
   */
  fileDuplicateSuggestion(args: {
    aRecordId: string;
    aPath: string;
    bRecordId: string;
    bPath: string;
    distance: number;
    now: string;
  }): boolean {
    const existing = this.#findExisting.get(
      args.aRecordId,
      args.bRecordId,
      args.bRecordId,
      args.aRecordId
    );
    if (existing) return false;
    const payload: DuplicateSuggestionPayload = {
      a_record: args.aRecordId,
      a_path: args.aPath,
      b_record: args.bRecordId,
      b_path: args.bPath,
      distance: args.distance
    };
    this.#insert.run(uuidv7(), args.aRecordId, JSON.stringify(payload), args.now);
    return true;
  }
}

export interface CompactionCandidatePayload {
  folder_path: string;
  piece_count: number;
  total_bytes: number;
  oldest_created: string;
  newest_created: string;
}

/**
 * `compaction_candidate` — a folder of pieces has accumulated enough
 * content (piece-count threshold) to warrant a compaction pass. The agent
 * (via `/vault-compact <folder>`) decides what to archive and writes the
 * summary; this filer just surfaces "this folder is ripe."
 *
 * Not record-scoped — `subject_id` is null. Idempotent on
 * `(folder_path, status='pending')`. Auto-resolves with
 * `resolved_by='no-longer-eligible'` on the next scan where the folder
 * has dropped below the threshold (typical trigger: `/vault-compact`
 * archived the bulk of the pieces, leaving only the recent ones).
 */
export class CompactionCandidateFiler {
  readonly #findExisting: StatementSync;
  readonly #insert: StatementSync;
  readonly #autoAcceptForFolder: StatementSync;

  constructor(db: DatabaseSync) {
    this.#findExisting = db.prepare(
      `SELECT id FROM suggestions
       WHERE kind = 'compaction_candidate'
         AND status = 'pending'
         AND json_extract(payload, '$.folder_path') = ?
       LIMIT 1`
    );
    this.#insert = db.prepare(
      `INSERT INTO suggestions (id, kind, subject_id, payload, status, created)
       VALUES (?, 'compaction_candidate', NULL, ?, 'pending', ?)`
    );
    this.#autoAcceptForFolder = db.prepare(
      `UPDATE suggestions
          SET status = 'accepted',
              resolved_at = ?,
              resolved_by = 'no-longer-eligible'
        WHERE kind = 'compaction_candidate'
          AND status = 'pending'
          AND json_extract(payload, '$.folder_path') = ?`
    );
  }

  /**
   * File a pending suggestion for `folder_path`. Returns true if filed,
   * false if a pending suggestion already exists for the folder.
   */
  fileCandidate(args: {
    folderPath: string;
    pieceCount: number;
    totalBytes: number;
    oldestCreated: string;
    newestCreated: string;
    now: string;
  }): boolean {
    const existing = this.#findExisting.get(args.folderPath);
    if (existing) return false;
    const payload: CompactionCandidatePayload = {
      folder_path: args.folderPath,
      piece_count: args.pieceCount,
      total_bytes: args.totalBytes,
      oldest_created: args.oldestCreated,
      newest_created: args.newestCreated
    };
    this.#insert.run(uuidv7(), JSON.stringify(payload), args.now);
    return true;
  }

  /**
   * Auto-accept any pending `compaction_candidate` for `folder_path`
   * when the folder no longer qualifies (post-compaction or after
   * pieces were moved). Returns true if a pending was promoted.
   */
  autoAcceptForFolder(folderPath: string, now: string): boolean {
    return this.#autoAcceptForFolder.run(now, folderPath).changes > 0;
  }
}

export interface ArchiveCandidatePayload {
  record_id: string;
  file_path: string;
  type: string;
  status: string;
  /** Days since the timestamp that triggered the threshold (typically `updated`). */
  age_days: number;
  /** Threshold the record crossed (e.g. "log > 90d"). */
  rule: string;
}

/**
 * `archive_candidate` — the per-type retention scan flagged a record as
 * past its calendar threshold (logs > 90d, queries > 180d, queue-items
 * with status='done' for > 90d, etc.). The agent (or user) decides
 * whether to flip status to 'archived' or reject the suggestion.
 *
 * Idempotent on `(record_id, status='pending')`. Auto-resolves with
 * `resolved_by='archived'` when the record's status becomes
 * 'archived' on next import (the user/skill flipped FM in response).
 */
export class ArchiveCandidateFiler {
  readonly #findExisting: StatementSync;
  readonly #insert: StatementSync;
  readonly #autoAcceptForRecord: StatementSync;

  constructor(db: DatabaseSync) {
    this.#findExisting = db.prepare(
      `SELECT id FROM suggestions
       WHERE kind = 'archive_candidate'
         AND status = 'pending'
         AND subject_id = ?
       LIMIT 1`
    );
    this.#insert = db.prepare(
      `INSERT INTO suggestions (id, kind, subject_id, payload, status, created)
       VALUES (?, 'archive_candidate', ?, ?, 'pending', ?)`
    );
    this.#autoAcceptForRecord = db.prepare(
      `UPDATE suggestions
          SET status = 'accepted',
              resolved_at = ?,
              resolved_by = 'archived'
        WHERE kind = 'archive_candidate'
          AND status = 'pending'
          AND subject_id = ?`
    );
  }

  /**
   * File a pending archive_candidate. Returns true if filed; false if a
   * pending suggestion already exists for the record.
   */
  fileCandidate(args: {
    recordId: string;
    filePath: string;
    type: string;
    status: string;
    ageDays: number;
    rule: string;
    now: string;
  }): boolean {
    const existing = this.#findExisting.get(args.recordId);
    if (existing) return false;
    const payload: ArchiveCandidatePayload = {
      record_id: args.recordId,
      file_path: args.filePath,
      type: args.type,
      status: args.status,
      age_days: args.ageDays,
      rule: args.rule
    };
    this.#insert.run(uuidv7(), args.recordId, JSON.stringify(payload), args.now);
    return true;
  }

  /**
   * Auto-accept any pending archive_candidate for a record that's now
   * been moved to status='archived'. Returns true if a pending was
   * promoted.
   */
  autoAcceptForRecord(recordId: string, now: string): boolean {
    return this.#autoAcceptForRecord.run(now, recordId).changes > 0;
  }
}

export interface UpgradeSignalPayload {
  signal: string;
  current: number;
  threshold: number;
  recommendation: string;
}

/**
 * `inefficiency_detected` and `infrastructure_upgrade` — filed by the
 * time-to-upgrade evaluator when a backend-shape signal trips. Different
 * kinds for different remediation flavours:
 *
 * - `inefficiency_detected`: tune-and-stay (VACUUM, prune, raise an index
 *   limit).
 * - `infrastructure_upgrade`: the recommended remedy is migrating to a
 *   more robust backend (Postgres+pgvector+AGE per the design's
 *   backend-comparison doc).
 *
 * Idempotent on `(kind, signal, status='pending')`. The same (kind,
 * signal) pair never re-files while one is pending — the existing
 * suggestion's payload reflects the most recent observation, but
 * resolving (accept / reject) lets the next scan re-fire if the signal
 * is still tripping.
 */
export class UpgradeSignalFiler {
  readonly #findExisting: StatementSync;
  readonly #insert: StatementSync;

  constructor(db: DatabaseSync) {
    this.#findExisting = db.prepare(
      `SELECT id FROM suggestions
       WHERE kind = ?
         AND status = 'pending'
         AND json_extract(payload, '$.signal') = ?
       LIMIT 1`
    );
    this.#insert = db.prepare(
      `INSERT INTO suggestions (id, kind, subject_id, payload, status, created)
       VALUES (?, ?, NULL, ?, 'pending', ?)`
    );
  }

  fileSignal(args: {
    kind: 'inefficiency_detected' | 'infrastructure_upgrade';
    signal: string;
    current: number;
    threshold: number;
    recommendation: string;
    now: string;
  }): boolean {
    const existing = this.#findExisting.get(args.kind, args.signal);
    if (existing) return false;
    const payload: UpgradeSignalPayload = {
      signal: args.signal,
      current: args.current,
      threshold: args.threshold,
      recommendation: args.recommendation
    };
    this.#insert.run(uuidv7(), args.kind, JSON.stringify(payload), args.now);
    return true;
  }
}

export interface AgentEnrichmentStalePayload {
  record_id: string;
  file_path: string;
  /** Body content_hash recorded by the LLM at derivation time. */
  agent_derived_from_hash: string;
  /** Body content_hash *now*; the divergence is the staleness signal. */
  current_body_hash: string;
}

/**
 * `agent_enrichment_stale` — the source FM has both `agent.summary` and
 * `agent.derived_from_hash` but the recorded hash no longer matches the
 * body's current hash. The LLM saw an older body; a refresh pass should
 * regenerate the agent block.
 *
 * Idempotent on `record_id` (one pending stale per record). Auto-resolves
 * to `accepted` with `resolved_by='hash-matched'` on the next import where
 * `agent.derived_from_hash === current body hash` again — i.e., the agent
 * block was refreshed (likely via `/vault-enrich-all`).
 */
export class AgentEnrichmentStaleFiler {
  readonly #findExisting: StatementSync;
  readonly #insert: StatementSync;
  readonly #autoAcceptForRecord: StatementSync;

  constructor(db: DatabaseSync) {
    this.#findExisting = db.prepare(
      `SELECT id FROM suggestions
       WHERE kind = 'agent_enrichment_stale'
         AND status = 'pending'
         AND subject_id = ?
       LIMIT 1`
    );
    this.#insert = db.prepare(
      `INSERT INTO suggestions (id, kind, subject_id, payload, status, created)
       VALUES (?, 'agent_enrichment_stale', ?, ?, 'pending', ?)`
    );
    this.#autoAcceptForRecord = db.prepare(
      `UPDATE suggestions
          SET status = 'accepted',
              resolved_at = ?,
              resolved_by = 'hash-matched'
        WHERE kind = 'agent_enrichment_stale'
          AND status = 'pending'
          AND subject_id = ?`
    );
  }

  /**
   * File a pending stale-enrichment suggestion for a record. Returns true
   * if filed; false if a prior pending suggestion already exists for the
   * record (only `pending` blocks re-filing — accepted/rejected entries
   * don't, so a re-flagged-and-resolved record can be flagged again later).
   */
  fileStaleSuggestion(args: {
    recordId: string;
    filePath: string;
    agentDerivedFromHash: string;
    currentBodyHash: string;
    now: string;
  }): boolean {
    const existing = this.#findExisting.get(args.recordId);
    if (existing) return false;
    const payload: AgentEnrichmentStalePayload = {
      record_id: args.recordId,
      file_path: args.filePath,
      agent_derived_from_hash: args.agentDerivedFromHash,
      current_body_hash: args.currentBodyHash
    };
    this.#insert.run(uuidv7(), args.recordId, JSON.stringify(payload), args.now);
    return true;
  }

  /**
   * Resolve any pending stale-enrichment suggestions for a record (called
   * when a fresh import shows the agent hash matches the body hash again).
   * Returns the count of suggestions auto-accepted.
   */
  autoAcceptForRecord(recordId: string, now: string): number {
    return Number(this.#autoAcceptForRecord.run(now, recordId).changes);
  }
}
