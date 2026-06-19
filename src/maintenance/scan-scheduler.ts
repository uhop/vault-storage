// C8.1 scan scheduler — the maintenance scans' autonomous cadence, with
// the "changed since last pass" simplification (decided 2026-06-11).
//
// The constraint's original adaptive backoff (5min↔2hr doubling) was
// designed for an edit-reflection scan whose cadence bounded edit-to-index
// latency. The watcher has since taken that job (reflection in ~1.5s), and
// what's left to schedule — find-duplicates / compaction / retention /
// upgrade-signals — is cheap (~seconds) and latency-insensitive. So instead
// of exponential backoff, each tick asks two questions:
//
//   1. Did the vault's content change since the last completed pass?
//      (`meta.content_generation`, bumped by RecordsRepository on every
//      upsert / delete / move — never by reads or suggestion writes.)
//   2. Has the last pass aged past `maxQuietMs`? Retention/decay scans
//      surface candidates from the *passage of time*, not from edits, so
//      an untouched vault still gets a periodic pass (default weekly).
//
// Yes to either → run the bundled pass; otherwise skip (one meta read).
// Work-hours window and manual-trigger-wins behavior mirror git-sync,
// which is the heuristic's first in-repo implementation: the timer only
// fires inside the window, while `POST /maintenance/run-all` runs whenever
// called and counts as a pass (it records the same marker).

import type {DatabaseSync} from 'node:sqlite';
import {getContentGeneration, getMetaValue} from '../db/meta.ts';
import {isWithinWorkHours, type WorkHoursWindow} from '../server/git-sync.ts';
import {runAllScans, SCAN_LAST_PASS_AT_KEY, SCAN_LAST_PASS_GENERATION_KEY} from './run-all.ts';

export interface ScanSchedulerOptions {
  db: DatabaseSync;
  /** Eligibility-check cadence. Each tick costs one meta read when it skips. */
  intervalMs?: number;
  /**
   * Force a pass when the last one is older than this, even with no content
   * changes — keeps time-driven scans (retention, decay) fresh on a quiet
   * vault. 0 forces a pass on every in-window tick.
   */
  maxQuietMs?: number;
  /** Same semantics as git-sync: ticks outside the window are no-ops. */
  workHours?: WorkHoursWindow;
  /** Hook for tests. */
  now?: () => Date;
  /** Scan runner — injectable for tests. Defaults to {@link runAllScans}. */
  runScans?: (db: DatabaseSync) => unknown;
  log?: (msg: string) => void;
  onError?: (err: unknown) => void;
}

export type ScanTickOutcome = 'ran' | 'skipped' | 'outside-window';

export interface ScanSchedulerHandle {
  /** Evaluate the skip rule now; `force` bypasses the work-hours window. */
  tickNow: (force?: boolean) => Promise<ScanTickOutcome>;
  close: () => void;
}

export const startScanScheduler = (opts: ScanSchedulerOptions): ScanSchedulerHandle => {
  const {db, workHours} = opts;
  const intervalMs = opts.intervalMs ?? 3_600_000;
  const maxQuietMs = opts.maxQuietMs ?? 7 * 86_400_000;
  const now = opts.now ?? (() => new Date());
  const runScans = opts.runScans ?? runAllScans;
  const log = opts.log ?? (msg => process.stdout.write(`vault-storage: ${msg}\n`));
  const onError =
    opts.onError ??
    (err =>
      process.stderr.write(
        `scan-scheduler: ${err instanceof Error ? err.message : String(err)}\n`
      ));

  let inFlight: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  let closed = false;

  const inWindow = (): boolean => {
    if (!workHours) return true;
    return isWithinWorkHours(now(), workHours.start, workHours.end);
  };

  const tickOnce = async (force: boolean): Promise<ScanTickOutcome> => {
    if (!force && !inWindow()) return 'outside-window';

    const generation = getContentGeneration(db);
    const lastGeneration = getMetaValue(db, SCAN_LAST_PASS_GENERATION_KEY);
    const lastAt = getMetaValue(db, SCAN_LAST_PASS_AT_KEY);
    const quietMs = lastAt === null ? Infinity : now().getTime() - Date.parse(lastAt);
    const unchanged = lastGeneration !== null && Number(lastGeneration) === generation;
    if (unchanged && quietMs < maxQuietMs) return 'skipped';

    await runScans(db);
    log(
      `scan-scheduler: maintenance pass completed (${
        unchanged
          ? `quiet ${Math.round(quietMs / 3_600_000)}h exceeded max`
          : `generation ${lastGeneration ?? 'none'} → ${generation}`
      })`
    );
    return 'ran';
  };

  const scheduleNext = (): void => {
    if (closed) return;
    timer = setTimeout(tick, intervalMs);
  };

  const tick = (): void => {
    inFlight = inFlight
      .then(() => tickOnce(false))
      .then(() => undefined)
      .catch(err => onError(err))
      .finally(() => scheduleNext());
  };

  scheduleNext();

  return {
    async tickNow(force = false) {
      let outcome!: ScanTickOutcome;
      inFlight = inFlight
        .then(async () => {
          outcome = await tickOnce(force);
        })
        .catch(err => {
          onError(err);
        });
      await inFlight;
      return outcome ?? 'skipped';
    },
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
    }
  };
};
