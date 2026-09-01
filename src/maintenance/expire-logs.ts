// Delete session logs past their retention window.
//
// The 2026-07-31 ruling makes log expiry settled policy rather than a
// per-record judgment: a durable note cites a log as a backticked plain
// path, never a `[[logs/…]]` wikilink, so nothing resolves through a
// deleted log. find-retention-candidates.ts files logs as
// `archive_candidate` — the one suggestion kind `/vault sweep` may never
// drain — so the signal existed with no mechanism behind it.
//
// Anchored on `created`, not `updated`: a session log's content never
// changes, so its age is the session's date, while `updated` is bumped by
// machine touches (an `agent:` enrichment refresh re-stamps it) and would
// extend a log's life indefinitely. Deliberately diverges from the scan,
// which is `updated`-keyed across every type.
//
// `type: log` is the whole predicate. The `_summary-*` distillates the
// policy preserves are `type: meta`, so they fall outside it by typing
// rather than by name matching.
//
// Suggestion bookkeeping is the schema's: records_after_delete_resolve_
// suggestions (0009, current in 0015) closes any pending or claimed
// suggestion as the record row goes.

import {existsSync, statSync, unlinkSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
import {RecordsRepository} from '../records/repository.ts';
import type {VaultRecord} from '../records/types.ts';
import {joinVaultPath} from '../server/writer.ts';

/** Retention window for `type: log`, per topics/vault-hygiene-policy. */
export const DEFAULT_LOG_RETENTION_DAYS = 90;

export interface ExpireLogsOptions {
  /** Age threshold in days. Default {@link DEFAULT_LOG_RETENTION_DAYS}. */
  days?: number;
  /** Override the timestamp anchor (test injection). */
  now?: string;
  /** Report what would be deleted without touching disk or DB. */
  dryRun?: boolean;
  /** Cap deletions per call; omitted means no cap. */
  limit?: number;
}

export interface ExpiredLog {
  record_id: string;
  file_path: string;
  age_days: number;
}

export interface ExpireLogsSummary {
  /** `type: log` records evaluated (post status filter). */
  scanned: number;
  /** Records past threshold this pass. */
  qualifying: number;
  /** Records actually removed; always 0 under `dryRun`. */
  deleted: number;
  /** The qualifying records, oldest first — the audit trail. */
  logs: ExpiredLog[];
  dryRun: boolean;
  days: number;
  errors: Array<{file_path: string; message: string}>;
  durationMs: number;
}

const MS_PER_DAY = 86_400_000;

const ageDays = (record: VaultRecord, nowMs: number): number | null => {
  // `created` is the session date and never moves; `updated` only covers
  // a record whose FM lacks a parseable `created`.
  for (const anchor of [record.created, record.updated]) {
    const t = Date.parse(anchor);
    if (Number.isFinite(t)) return Math.max(0, (nowMs - t) / MS_PER_DAY);
  }
  return null;
};

/**
 * Delete every `type: log` record older than the retention window, from
 * disk and from the DB. Records already `archived` or `superseded` are
 * skipped — they are out of the active set, and archival is the other
 * disposition the policy allows.
 *
 * A record whose file is already gone from disk still has its row
 * removed: the row is the thing the index serves, and a missing file is
 * the state a partial earlier pass leaves behind.
 */
export const expireLogs = (
  db: DatabaseSync,
  vaultRoot: string,
  options: ExpireLogsOptions = {}
): ExpireLogsSummary => {
  const days = options.days ?? DEFAULT_LOG_RETENTION_DAYS;
  const now = options.now ?? new Date().toISOString();
  const nowMs = Date.parse(now);
  const dryRun = options.dryRun === true;

  const records = new RecordsRepository(db);
  const start = performance.now();
  const summary: ExpireLogsSummary = {
    scanned: 0,
    qualifying: 0,
    deleted: 0,
    logs: [],
    dryRun,
    days,
    errors: [],
    durationMs: 0
  };

  const candidates: Array<{record: VaultRecord; age: number}> = [];
  for (const r of records.listAll() as VaultRecord[]) {
    if (r.type !== 'log') continue;
    if (r.status === 'archived' || r.status === 'superseded') continue;
    summary.scanned++;
    const age = ageDays(r, nowMs);
    if (age === null || age < days) continue;
    candidates.push({record: r, age});
  }

  candidates.sort((a, b) => b.age - a.age);
  summary.qualifying = candidates.length;

  const batch = options.limit === undefined ? candidates : candidates.slice(0, options.limit);
  for (const {record, age} of batch) {
    summary.logs.push({
      record_id: record.recordId,
      file_path: record.filePath,
      age_days: Math.round(age)
    });
    if (dryRun) continue;
    try {
      const abs = joinVaultPath(vaultRoot, record.filePath);
      if (existsSync(abs) && statSync(abs).isFile()) unlinkSync(abs);
      records.delete(record.recordId);
      summary.deleted++;
    } catch (err) {
      summary.errors.push({file_path: record.filePath, message: (err as Error).message});
    }
  }

  summary.durationMs = Math.round(performance.now() - start);
  return summary;
};
