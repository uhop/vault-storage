// Per-type calendar retention scan that files `archive_candidate`
// suggestions for records past their type's age threshold. The scan
// itself never archives — the agent (or user) decides via FM edit
// (`status: archived`) or rejects the suggestion.
//
// Per design: "logs decay aggressively, project state doesn't, decisions
// never (the *why* matters years later)." Default thresholds calibrated
// for personal-vault scale; configurable per call.
//
// Auto-resolve: import-file.ts hooks the filer's autoAcceptForRecord on
// status='archived' transitions, so flipping FM closes the suggestion
// loop without the agent having to touch the suggestions table.

import type {DatabaseSync} from 'node:sqlite';
import {SuggestionFiler} from '../importer/file-suggestions.ts';
import {RecordsRepository} from '../records/repository.ts';
import type {RecordType, VaultRecord} from '../records/types.ts';

interface UpdatedRule {
  kind: 'updated';
  days: number;
}
interface DoneSinceRule {
  kind: 'done-since';
  days: number;
}
type RetentionRule = UpdatedRule | DoneSinceRule;

/**
 * Default per-type retention thresholds. `null` means no auto-archive
 * (the type is long-lived; never decays out of the active set on its
 * own). Override per call via {@link FindRetentionOptions.rules}.
 */
export const DEFAULT_RETENTION_RULES: Readonly<Record<RecordType, RetentionRule | null>> = {
  log: {kind: 'updated', days: 90},
  query: {kind: 'updated', days: 180},
  fleeting: {kind: 'updated', days: 30},
  'queue-item': {kind: 'done-since', days: 90},
  'bug-report': {kind: 'done-since', days: 180},
  // Long-lived; never auto-archive:
  research: null,
  permanent: null,
  design: null,
  idea: null,
  plan: null,
  project: null,
  state: null,
  meta: null,
  index: null
};

export interface FindRetentionOptions {
  /** Override the threshold map. Keys not provided fall back to the default. */
  rules?: Partial<Record<RecordType, RetentionRule | null>>;
  /** Override the timestamp anchor (test injection). */
  now?: string;
  /**
   * Snooze window (days) applied to a prior *reject* of a record's
   * `archive_candidate` before it may re-surface. Default
   * `DEFAULT_SNOOZE_DAYS` (in file-suggestions.ts).
   */
  snoozeDays?: number;
}

export interface FindRetentionSummary {
  /** Records evaluated (post type / status filter). */
  scanned: number;
  /** Records that crossed threshold this pass. */
  qualifying: number;
  /** New `archive_candidate` suggestions filed. */
  filed: number;
  durationMs: number;
}

const MS_PER_DAY = 86_400_000;

const ageDays = (anchorIso: string, nowMs: number): number => {
  const t = Date.parse(anchorIso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (nowMs - t) / MS_PER_DAY);
};

/**
 * Walk every record, apply the per-type retention rule, file
 * archive_candidate for each record past threshold. Records already in
 * `archived` or `superseded` status are skipped (no point flagging
 * what's already out of the active set).
 */
export const findRetentionCandidates = (
  db: DatabaseSync,
  options: FindRetentionOptions = {}
): FindRetentionSummary => {
  const rules = {...DEFAULT_RETENTION_RULES, ...(options.rules ?? {})};
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);

  const records = new RecordsRepository(db);
  const filer = new SuggestionFiler(db, 'archive_candidate');

  const start = performance.now();
  const summary: FindRetentionSummary = {scanned: 0, qualifying: 0, filed: 0, durationMs: 0};

  for (const r of records.listAll() as VaultRecord[]) {
    if (r.status === 'archived' || r.status === 'superseded') continue;
    const rule = rules[r.type];
    if (rule === null || rule === undefined) continue;
    summary.scanned++;
    if (rule.kind === 'done-since' && r.status !== 'done') continue;
    const age = ageDays(r.updated, nowMs);
    if (age < rule.days) continue;
    summary.qualifying++;
    const ruleStr =
      rule.kind === 'updated'
        ? `${r.type} > ${rule.days}d`
        : `${r.type} done-since > ${rule.days}d`;
    if (
      filer.file(
        {
          record_id: r.recordId,
          file_path: r.filePath,
          type: r.type,
          status: r.status,
          age_days: Math.round(age),
          rule: ruleStr
        },
        now,
        {snoozeDays: options.snoozeDays}
      )
    ) {
      summary.filed++;
    }
  }

  summary.durationMs = Math.round(performance.now() - start);
  return summary;
};
