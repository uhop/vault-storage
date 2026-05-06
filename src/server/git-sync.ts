// Periodic git auto-commit (and optional push) for the vault content tree.
// Tier 1 backup per C2: while the server is running, pending markdown changes
// land in commits without the user thinking about it.
//
// Adaptive scheduling (C8.1):
//   - **Backoff on quiet.** After a poll that finds nothing to commit, the
//     next interval doubles up to `intervalMaxMs`. A successful commit
//     resets to the floor (`intervalMs`). When `intervalMaxMs` is 0 or
//     equal to the floor, backoff is disabled and the interval is fixed.
//   - **Work-hours window.** When `workHours` is set, polls outside the
//     window are immediate no-ops (no `git status` shells out). Manual
//     `syncNow()` always runs — the window only suppresses the timer.
//
// Design:
//   - If the working tree is dirty: `git add -A && git commit -m "<msg>"`.
//   - If `autoPush` is true: `git push` after a successful commit. Failures
//     log but don't crash — push is best-effort.
//   - All git invocations are wrapped: missing git, non-repo, network errors
//     all surface as warnings, not crashes.

import type {DatabaseSync} from 'node:sqlite';
import {setLastIndexedCommit} from '../maintenance/incremental-reindex.ts';
import {getCurrentHead, isGitRepo, runGit} from '../util/git.ts';

export interface WorkHoursWindow {
  /** `HH:MM` in 24-hour local time. */
  start: string;
  /** `HH:MM` in 24-hour local time. End is exclusive (`[start, end)`). */
  end: string;
}

export interface GitSyncOptions {
  vaultDataPath: string;
  /** Polling floor (also the only interval when backoff is disabled). */
  intervalMs?: number;
  /**
   * Polling ceiling for the backoff. After a quiet poll, the next interval
   * doubles up to this cap; a commit resets to the floor. 0 or values <=
   * intervalMs disable backoff (interval stays at floor).
   */
  intervalMaxMs?: number;
  /**
   * Optional work-hours gate. When set, the timer fires through the
   * window only. Outside, polls return immediately. `syncNow()` ignores
   * the window so manual `POST /commit` always runs.
   */
  workHours?: WorkHoursWindow;
  /** Hook for tests — defaults to `() => Date.now()`. */
  now?: () => Date;
  autoPush?: boolean;
  /** Override the commit subject; default includes the file count. */
  commitSubject?: (changedFiles: number) => string;
  /**
   * Author/committer identity for `git commit`. Passed via `-c user.name=…
   * -c user.email=…` so the container doesn't need a global gitconfig.
   * Defaults: `vault-storage` / `vault-storage@localhost`.
   */
  authorName?: string;
  authorEmail?: string;
  /**
   * When provided, advance `meta.last_indexed_commit` to the new HEAD
   * after each successful auto-commit. Keeps the multi-writer reindex
   * anchor in sync with reality so a subsequent post-pull diff sees a
   * clean range. Optional — bulk-import callers can manage the anchor
   * themselves.
   */
  db?: DatabaseSync;
  log?: (msg: string) => void;
  onError?: (err: unknown) => void;
}

export interface GitSyncHandle {
  /** Trigger a sync now (used on shutdown). */
  syncNow: () => Promise<void>;
  close: () => void;
}

const defaultSubject = (n: number): string =>
  `vault-storage auto-commit (${n} file${n === 1 ? '' : 's'})`;

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Convert `HH:MM` into minutes-since-midnight. Caller validates the format
 * up the stack; this throws if it doesn't match.
 */
const minutesOfDay = (hhmm: string): number => {
  const m = TIME_OF_DAY_RE.exec(hhmm);
  if (!m) throw new Error(`invalid HH:MM: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
};

/**
 * Returns true when `now`'s local time is inside `[start, end)`. When the
 * window straddles midnight (`end < start`, e.g. 22:00–06:00), the
 * inclusive segment is treated as a wrap.
 */
export const isWithinWorkHours = (now: Date, start: string, end: string): boolean => {
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = minutesOfDay(start);
  const e = minutesOfDay(end);
  if (s === e) return false; // empty window (caller probably misconfigured)
  if (s < e) return cur >= s && cur < e;
  // Wrap-around window (e.g. 22:00–06:00) — inside if before end OR at/after start.
  return cur >= s || cur < e;
};

export const startGitSync = (opts: GitSyncOptions): GitSyncHandle => {
  const {vaultDataPath} = opts;
  const intervalMs = opts.intervalMs ?? 60_000;
  const intervalMaxMs = opts.intervalMaxMs ?? 0;
  const backoffEnabled = intervalMaxMs > intervalMs;
  const autoPush = opts.autoPush ?? false;
  const commitSubject = opts.commitSubject ?? defaultSubject;
  const authorName = opts.authorName ?? 'vault-storage';
  const authorEmail = opts.authorEmail ?? 'vault-storage@localhost';
  const workHours = opts.workHours;
  const now = opts.now ?? (() => new Date());
  const identityArgs = ['-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`];
  const log = opts.log ?? (msg => process.stdout.write(`vault-storage: ${msg}\n`));
  const onError =
    opts.onError ??
    (err =>
      process.stderr.write(`git-sync: ${err instanceof Error ? err.message : String(err)}\n`));

  if (!isGitRepo(vaultDataPath)) {
    log(`git-sync: ${vaultDataPath} is not a git repo, auto-commit disabled`);
    return {syncNow: async () => {}, close: () => {}};
  }

  let inFlight: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  /**
   * Outcome of the most recent poll: `committed` resets the interval to
   * floor, `quiet` doubles up to ceiling, `skipped` (work-hours gate)
   * keeps the current interval (no progress, no backoff penalty either).
   */
  let currentIntervalMs = intervalMs;

  const inWindow = (): boolean => {
    if (!workHours) return true;
    return isWithinWorkHours(now(), workHours.start, workHours.end);
  };

  /** Returns 'committed', 'quiet', or 'skipped'. */
  const syncOnce = async (force: boolean): Promise<'committed' | 'quiet' | 'skipped'> => {
    if (!force && !inWindow()) return 'skipped';

    const status = await runGit(vaultDataPath, ['status', '--porcelain']);
    if (status.exitCode !== 0) {
      onError(new Error(`git status failed: ${status.stderr.trim()}`));
      return 'quiet';
    }
    const dirtyLines = status.stdout.split('\n').filter(l => l.length > 0);
    if (dirtyLines.length === 0) return 'quiet';

    const add = await runGit(vaultDataPath, ['add', '-A']);
    if (add.exitCode !== 0) {
      onError(new Error(`git add failed: ${add.stderr.trim()}`));
      return 'quiet';
    }
    const subject = commitSubject(dirtyLines.length);
    const commit = await runGit(vaultDataPath, [...identityArgs, 'commit', '-m', subject]);
    if (commit.exitCode !== 0) {
      // "nothing to commit" can happen if files were only in .gitignore.
      const benign =
        /nothing to commit/i.test(commit.stdout) || /nothing to commit/i.test(commit.stderr);
      if (!benign)
        onError(new Error(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`));
      return 'quiet';
    }
    log(`git-sync: committed ${dirtyLines.length} change(s)`);

    // Advance the multi-writer reindex anchor so a later post-pull diff
    // sees a coherent `last_indexed_commit..HEAD` range. The watcher
    // already imported the file changes that produced this commit; we
    // just need the anchor to track HEAD.
    if (opts.db) {
      const head = await getCurrentHead(vaultDataPath);
      if (head) setLastIndexedCommit(opts.db, head);
    }

    if (autoPush) {
      const push = await runGit(vaultDataPath, ['push']);
      if (push.exitCode !== 0) {
        onError(new Error(`git push failed: ${push.stderr.trim()}`));
        return 'committed';
      }
      log('git-sync: pushed to remote');
    }
    return 'committed';
  };

  const advance = (outcome: 'committed' | 'quiet' | 'skipped'): void => {
    if (!backoffEnabled) return;
    if (outcome === 'committed') {
      currentIntervalMs = intervalMs;
    } else if (outcome === 'quiet') {
      currentIntervalMs = Math.min(currentIntervalMs * 2, intervalMaxMs);
    }
    // 'skipped' (outside work-hours): hold the current interval.
  };

  const scheduleNext = (): void => {
    if (closed) return;
    timer = setTimeout(tick, currentIntervalMs);
  };

  const tick = (): void => {
    inFlight = inFlight
      .then(() => syncOnce(false))
      .then(outcome => advance(outcome))
      .catch(err => onError(err))
      .finally(() => scheduleNext());
  };

  scheduleNext();

  return {
    async syncNow() {
      // Manual trigger always runs (force=true bypasses the work-hours
      // gate). Doesn't perturb the backoff interval — manual nudges
      // shouldn't hold the auto-commit cadence at the floor forever.
      inFlight = inFlight.then(() => syncOnce(true)).then(() => undefined);
      await inFlight;
    },
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
    }
  };
};
