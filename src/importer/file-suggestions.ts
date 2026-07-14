// Filing logic for indexer-driven suggestions.
//
// One generic `SuggestionFiler` serves every suggestion kind. `FILER_SPECS`
// is the single home for each kind's semantics: the identity key that makes
// filing idempotent, the blocking scope (which prior statuses prevent
// re-filing — the durable-reject vs snooze vs pending-only distinction), and
// the payload field mirrored into `subject_id`. Re-imports of unchanged
// content produce no new suggestions.

import type {DatabaseSync, SQLInputValue, StatementSync} from 'node:sqlite';
import {uuidv7} from '../util/uuid.ts';

const MS_PER_DAY = 86_400_000;

/**
 * Default snooze window (days) for the *recurring-condition* kinds
 * (`archive_candidate`, `compaction_candidate`). A reject of these means
 * "not now," not "never" — the underlying trigger (file age, folder size)
 * persists and legitimately worsens over time, so a rejected suggestion
 * blocks re-filing only until its `resolved_at` falls outside this window,
 * after which the next scan may re-surface it.
 *
 * The *classification* kinds (`edge_type`, `new_tag`, `tag_suggestion`,
 * `duplicate`) deliberately do NOT snooze — their reject is a permanent
 * wrong-classification verdict and blocks across all statuses forever.
 */
export const DEFAULT_SNOOZE_DAYS = 14;

/**
 * ISO instant marking the start of the snooze window: a rejected row whose
 * `resolved_at >= snoozeCutoff(now, days)` still blocks re-filing. Falls back
 * to `now` (so no extra blocking) when `now` is unparseable.
 */
const snoozeCutoff = (now: string, snoozeDays: number): string => {
  const t = Date.parse(now);
  if (!Number.isFinite(t)) return now;
  return new Date(t - snoozeDays * MS_PER_DAY).toISOString();
};

export interface EdgeSuggestionPayload {
  from_record: string;
  from_path: string;
  to_record: string;
  to_path: string;
  classifier_type: 'cites';
  context: string;
}

export interface NewTagSuggestionPayload {
  tag: string;
  record_id: string;
  file_path: string;
}

export interface TagSuggestionPayload {
  tag: string;
  record_id: string;
  file_path: string;
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

export interface CompactionCandidatePayload {
  folder_path: string;
  piece_count: number;
  total_bytes: number;
  oldest_created: string;
  newest_created: string;
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

export interface UpgradeSignalPayload {
  signal: string;
  current: number;
  threshold: number;
  recommendation: string;
  [extra: string]: unknown;
}

export interface AgentEnrichmentStalePayload {
  record_id: string;
  file_path: string;
  /** Body content_hash recorded by the LLM at derivation time. */
  agent_derived_from_hash: string;
  /** Body content_hash *now*; the divergence is the staleness signal. */
  current_body_hash: string;
}

/** Wire payload per suggestion kind. */
export interface KindPayloads {
  edge_type: EdgeSuggestionPayload;
  new_tag: NewTagSuggestionPayload;
  tag_suggestion: TagSuggestionPayload;
  duplicate: DuplicateSuggestionPayload;
  compaction_candidate: CompactionCandidatePayload;
  archive_candidate: ArchiveCandidatePayload;
  inefficiency_detected: UpgradeSignalPayload;
  infrastructure_upgrade: UpgradeSignalPayload;
  agent_enrichment_stale: AgentEnrichmentStalePayload;
}

export type SuggestionKind = keyof KindPayloads;

/**
 * Which prior suggestions block re-filing the same identity:
 *
 * - `all-statuses` — classification kinds: a reject is a permanent
 *   wrong-classification verdict; once the user has triaged a pair it never
 *   re-files. Resurfacing is an explicit operator action (manual re-create
 *   via `POST /suggestions`, or repository-level edit).
 * - `pending-or-snoozed-reject` — recurring-condition kinds: a reject means
 *   "not now"; the rejected row blocks only while inside the snooze window
 *   ({@link DEFAULT_SNOOZE_DAYS}), after which the next scan may re-surface.
 * - `pending-only` — observation kinds: resolving (accept / reject) lets the
 *   next scan re-fire if the condition still holds.
 */
type BlockingScope = 'all-statuses' | 'pending-or-snoozed-reject' | 'pending-only';

/**
 * A match key names a payload field (compared via `json_extract`), or the
 * literal `'subject'` for the `subject_id` column.
 */
type MatchKey = string;

interface FilerSpec {
  /** Idempotency key — `file()` skips when a blocking row matches these values. */
  identity: readonly MatchKey[];
  /** The identity is an unordered pair; either orientation matches. */
  symmetric?: boolean;
  blocking: BlockingScope;
  /** Payload field mirrored into `subject_id`; null = not record-scoped. */
  subject: string | null;
}

const FILER_SPECS: Record<SuggestionKind, FilerSpec> = {
  /**
   * The body-wikilink classifier defaults un-cued links to `cites`; each
   * unreviewed default-cites pair is filed for agent review. Resolution lives
   * in the source record's frontmatter `edges:` map; build-edges applies the
   * override on next reindex and auto-accepts the matching pending suggestion
   * (`resolved_by='fm-override'`).
   */
  edge_type: {
    identity: ['from_record', 'to_record'],
    blocking: 'all-statuses',
    subject: 'from_record'
  },
  /**
   * TagsImporter rejects unknown tags (not in `tags_taxonomy` and not
   * aliased); each `(tag, record)` rejection files. The agent sees N
   * suggestions for the same tag if it appears on N records. Resolution is
   * via POST /tags/taxonomy or POST /tags/aliases, which backfills the tag
   * link and auto-accepts every pending suggestion for the tag
   * (`accept({tag}, 'taxonomy-add' | 'alias-add')`).
   */
  new_tag: {identity: ['tag', 'record_id'], blocking: 'all-statuses', subject: 'record_id'},
  /**
   * Agent-judged additions from `agent.tags_suggested`. The tag is NOT (yet)
   * on the record's FM `tags:`; the agent thinks it should be — distinct from
   * `new_tag` (fired when an unknown tag IS on FM but isn't in the taxonomy).
   * A prior rejection is durable: once the user says "no, this tag doesn't
   * fit this record," re-imports won't refile — prevents recurring noise from
   * agent body-content inferences the user already triaged once.
   * Auto-resolves on import via {@link acceptRealizedTagSuggestions} once the
   * suggested tag is realized on the record.
   */
  tag_suggestion: {identity: ['tag', 'record_id'], blocking: 'all-statuses', subject: 'record_id'},
  /**
   * High-similarity record pair from the maintenance scan. Idempotent on the
   * unordered pair — the scan canonicalizes (lower record_id first), but the
   * symmetric match keeps idempotency intact across schema/scan changes.
   */
  duplicate: {
    identity: ['a_record', 'b_record'],
    symmetric: true,
    blocking: 'all-statuses',
    subject: 'a_record'
  },
  /**
   * A folder of pieces has accumulated enough content (piece-count threshold)
   * to warrant a compaction pass. The agent (via `/vault-compact <folder>`)
   * decides what to archive and writes the summary; filing just surfaces
   * "this folder is ripe." Not record-scoped. The scan auto-accepts pendings
   * with `resolved_by='no-longer-eligible'` once the folder drops below the
   * threshold (typical trigger: `/vault-compact` archived the bulk).
   */
  compaction_candidate: {
    identity: ['folder_path'],
    blocking: 'pending-or-snoozed-reject',
    subject: null
  },
  /**
   * The per-type retention scan flagged a record as past its calendar
   * threshold (logs > 90d, queries > 180d, done queue-items > 90d, …). The
   * agent (or user) flips status to 'archived' or rejects; import auto-accepts
   * pendings with `resolved_by='archived'` once the status flip lands.
   */
  archive_candidate: {
    identity: ['subject'],
    blocking: 'pending-or-snoozed-reject',
    subject: 'record_id'
  },
  /**
   * Filed by the time-to-upgrade evaluator when a backend-shape signal trips:
   * tune-and-stay remediation (VACUUM, prune, raise an index limit). The same
   * signal never re-files while one is pending; resolving (accept / reject)
   * lets the next scan re-fire if the signal still trips.
   */
  inefficiency_detected: {identity: ['signal'], blocking: 'pending-only', subject: null},
  /**
   * Same evaluator as `inefficiency_detected`, but the recommended remedy is
   * migrating to a more robust backend (Postgres+pgvector+AGE per the
   * design's backend-comparison doc).
   */
  infrastructure_upgrade: {identity: ['signal'], blocking: 'pending-only', subject: null},
  /**
   * The source FM has both `agent.summary` and `agent.derived_from_hash` but
   * the recorded hash no longer matches the body's current hash — the LLM saw
   * an older body; a refresh pass should regenerate the agent block. One
   * pending per record; import auto-accepts with `resolved_by='hash-matched'`
   * once the hashes agree again (likely via `/vault-enrich-all`).
   */
  agent_enrichment_stale: {identity: ['subject'], blocking: 'pending-only', subject: 'record_id'}
};

const column = (key: MatchKey): string =>
  key === 'subject' ? 'subject_id' : `json_extract(payload, '$.${key}')`;

const matchClause = (keys: readonly MatchKey[]): string =>
  keys.map(k => `${column(k)} = ?`).join(' AND ');

/**
 * Generic suggestion filer, parameterized by kind. Idempotency key, blocking
 * scope, and subject_id source come from {@link FILER_SPECS}.
 */
export class SuggestionFiler<K extends SuggestionKind = SuggestionKind> {
  readonly #db: DatabaseSync;
  readonly #kind: K;
  readonly #spec: FilerSpec;
  readonly #findExisting: StatementSync;
  readonly #insert: StatementSync;
  /** Lazily prepared accept/pending statements, keyed by op + match keys. */
  readonly #prepared = new Map<string, StatementSync>();

  constructor(db: DatabaseSync, kind: K) {
    this.#db = db;
    this.#kind = kind;
    const spec = (this.#spec = FILER_SPECS[kind]);
    let identityClause: string;
    if (spec.symmetric) {
      const [a, b] = spec.identity as readonly [MatchKey, MatchKey];
      identityClause = `((${column(a)} = ? AND ${column(b)} = ?) OR (${column(a)} = ? AND ${column(b)} = ?))`;
    } else {
      identityClause = matchClause(spec.identity);
    }
    // 'claimed' is unresolved-but-reserved (schema 0015) — it blocks and
    // settles exactly like 'pending' everywhere in this module.
    const blockingClause =
      spec.blocking === 'pending-only'
        ? ` AND status IN ('pending', 'claimed')`
        : spec.blocking === 'pending-or-snoozed-reject'
          ? ` AND (status IN ('pending', 'claimed') OR (status = 'rejected' AND resolved_at >= ?))`
          : '';
    this.#findExisting = db.prepare(
      `SELECT id FROM suggestions
       WHERE kind = '${kind}' AND ${identityClause}${blockingClause}
       LIMIT 1`
    );
    this.#insert = db.prepare(
      `INSERT INTO suggestions (id, kind, subject_id, payload, status, created)
       VALUES (?, '${kind}', ?, ?, 'pending', ?)`
    );
  }

  /**
   * File a pending suggestion. Returns true if filed; false when a prior
   * suggestion blocks it per the kind's blocking scope (see
   * {@link FILER_SPECS}). Callers can sum the true returns to report filed
   * counts in scan summaries.
   *
   * `snoozeDays` (default {@link DEFAULT_SNOOZE_DAYS}) only applies to
   * `pending-or-snoozed-reject` kinds. `subjectId` overrides the spec-derived
   * subject for kinds whose subject isn't in the payload (upgrade signals).
   */
  file(
    payload: KindPayloads[K],
    now: string,
    opts: {snoozeDays?: number; subjectId?: string | null} = {}
  ): boolean {
    const spec = this.#spec;
    const fields = payload as unknown as Record<string, string | undefined>;
    const subject =
      opts.subjectId !== undefined
        ? opts.subjectId
        : spec.subject === null
          ? null
          : (fields[spec.subject] ?? null);
    const identity = spec.identity.map(k => (k === 'subject' ? subject : (fields[k] ?? null)));
    const params: SQLInputValue[] = spec.symmetric
      ? [identity[0] ?? null, identity[1] ?? null, identity[1] ?? null, identity[0] ?? null]
      : identity;
    if (spec.blocking === 'pending-or-snoozed-reject') {
      params.push(snoozeCutoff(now, opts.snoozeDays ?? DEFAULT_SNOOZE_DAYS));
    }
    if (this.#findExisting.get(...params)) return false;
    this.#insert.run(uuidv7(), subject, JSON.stringify(payload), now);
    return true;
  }

  /**
   * Auto-accept pending suggestions matching `match` (payload fields, or
   * `'subject'` for the subject_id column), stamping `resolved_by`. Returns
   * the count promoted. The match may be the full identity (edge_type's
   * fm-override) or a subset (new_tag accepts by tag across all records).
   */
  accept(match: Record<string, string>, resolvedBy: string, now: string): number {
    const entries = Object.entries(match);
    const stmt = this.#statement(
      'accept',
      entries.map(e => e[0]),
      keys =>
        `UPDATE suggestions
            SET status = 'accepted', resolved_at = ?, resolved_by = ?,
                claimed_by = NULL, claimed_at = NULL, claim_expires = NULL
          WHERE kind = '${this.#kind}' AND status IN ('pending', 'claimed') AND ${matchClause(keys)}`
    );
    return Number(stmt.run(now, resolvedBy, ...entries.map(e => e[1])).changes);
  }

  /** Unresolved (pending or claimed) suggestions matching `match`, with payloads parsed. */
  pending(match: Record<string, string>): Array<{id: string; payload: KindPayloads[K]}> {
    const entries = Object.entries(match);
    const stmt = this.#statement(
      'pending',
      entries.map(e => e[0]),
      keys =>
        `SELECT id, payload FROM suggestions
          WHERE kind = '${this.#kind}' AND status IN ('pending', 'claimed') AND ${matchClause(keys)}`
    );
    const rows = stmt.all(...entries.map(e => e[1])) as Array<{id: string; payload: string}>;
    return rows.map(r => ({id: r.id, payload: JSON.parse(r.payload) as KindPayloads[K]}));
  }

  /** Accept a single suggestion by row id (pairs with {@link pending}). */
  acceptById(id: string, resolvedBy: string, now: string): boolean {
    const stmt = this.#statement(
      'accept-by-id',
      [],
      () =>
        `UPDATE suggestions
            SET status = 'accepted', resolved_at = ?, resolved_by = ?,
                claimed_by = NULL, claimed_at = NULL, claim_expires = NULL
          WHERE id = ?`
    );
    return stmt.run(now, resolvedBy, id).changes > 0;
  }

  #statement(
    op: string,
    keys: readonly MatchKey[],
    sql: (keys: readonly MatchKey[]) => string
  ): StatementSync {
    const cacheKey = `${op}|${keys.join(',')}`;
    let stmt = this.#prepared.get(cacheKey);
    if (!stmt) {
      stmt = this.#db.prepare(sql(keys));
      this.#prepared.set(cacheKey, stmt);
    }
    return stmt;
  }
}

/**
 * Auto-accept pending `tag_suggestion`s for a record whose stored payload
 * tag — after alias resolution via `resolve` — is now realized on the record
 * (`realized` is the record's canonical tag set). Resolving the payload tag
 * (rather than matching it verbatim against a canonical) covers an
 * alias-spelled payload, or a literal that only became an alias of a
 * now-realized canonical after the suggestion was filed — an exact match
 * would miss it and the suggestion would never clear. Returns the count
 * promoted (`resolved_by='tag-realized'`).
 */
export const acceptRealizedTagSuggestions = (
  filer: SuggestionFiler<'tag_suggestion'>,
  recordId: string,
  realized: ReadonlySet<string>,
  resolve: (tag: string) => string | null,
  now: string
): number => {
  let accepted = 0;
  for (const {id, payload} of filer.pending({record_id: recordId})) {
    const canonical = resolve(payload.tag);
    if (canonical !== null && realized.has(canonical)) {
      filer.acceptById(id, 'tag-realized', now);
      ++accepted;
    }
  }
  return accepted;
};
