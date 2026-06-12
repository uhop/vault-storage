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
//   - **Stale-lock recovery.** A leftover `.git/index.lock` (git process
//     killed mid-poll, e.g. by a container stop) starves every subsequent
//     `add`/`commit` — observed in production 2026-06-08→11: four days of
//     silently failed polls. When add/commit fails on a lock collision and
//     the lock is older than `lockStaleMs`, it cannot have a live holder
//     (in-container this module is the only git spawner, and `runGit`
//     children die with the server), so it is removed and the commit
//     retried once. A fresh lock is left alone — it may belong to a
//     user's manual git op through the host mount.
//   - **Failure ledger.** When `db` is provided, status/add/commit failures
//     increment `meta.git_sync_consecutive_failures` (+ `…_last_error`,
//     `…_failing_since`); any successful poll clears them. `/system/lint`
//     reads the streak as the `auto_commit_failing` check, so a dead
//     auto-commit surfaces in `/vault resume` instead of stderr.

import {statSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
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
  /**
   * Age beyond which a `.git/index.lock` blocking add/commit is treated as
   * orphaned and removed (one bounded retry follows). Default 10 minutes —
   * far above any real git op on a vault-sized repo, far below the poll
   * ceiling, so recovery lands within a couple of polls.
   */
  lockStaleMs?: number;
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

/** Initial attempt + one retry after a stale-lock removal. */
const MAX_COMMIT_ATTEMPTS = 2;

/** Matches git's `fatal: Unable to create '….git/index.lock': File exists.` */
const isLockCollision = (gitOutput: string): boolean =>
  gitOutput.includes('index.lock') && gitOutput.includes('File exists');

const FAILURE_META_KEYS =
  "('git_sync_consecutive_failures', 'git_sync_last_error', 'git_sync_failing_since')";

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
  const lockStaleMs = opts.lockStaleMs ?? 600_000;
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

  const recordFailure = (message: string): void => {
    if (!opts.db) return;
    const row = opts.db
      .prepare(`SELECT value FROM meta WHERE key = 'git_sync_consecutive_failures'`)
      .get() as {value?: string} | undefined;
    const prior = Number(row?.value ?? '0');
    const upsert = opts.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    upsert.run('git_sync_consecutive_failures', String((Number.isFinite(prior) ? prior : 0) + 1));
    upsert.run('git_sync_last_error', message);
    const since = opts.db
      .prepare(`SELECT value FROM meta WHERE key = 'git_sync_failing_since'`)
      .get();
    if (!since) upsert.run('git_sync_failing_since', now().toISOString());
  };

  const clearFailures = (): void => {
    if (!opts.db) return;
    opts.db.prepare(`DELETE FROM meta WHERE key IN ${FAILURE_META_KEYS}`).run();
  };

  /** Ledger + warning in one step; always resolves the poll as 'quiet'. */
  const fail = (err: Error): 'quiet' => {
    recordFailure(err.message);
    onError(err);
    return 'quiet';
  };

  /**
   * Remove `.git/index.lock` when it is provably orphaned (older than
   * `lockStaleMs`). Returns true when a retry is warranted: the lock was
   * removed, or it vanished on its own since the failed git call. A fresh
   * lock returns false — its holder may still be alive.
   */
  const removeStaleLock = (): boolean => {
    const lockPath = join(vaultDataPath, '.git', 'index.lock');
    try {
      const ageMs = now().getTime() - statSync(lockPath).mtimeMs;
      if (ageMs < lockStaleMs) return false;
      unlinkSync(lockPath);
      log(`git-sync: removed stale .git/index.lock (age ${Math.round(ageMs / 60_000)}min)`);
      return true;
    } catch {
      // statSync: lock already gone — its holder finished; retry is safe.
      // unlinkSync: lost a removal race to the same effect.
      return true;
    }
  };

  /** Returns 'committed', 'quiet', or 'skipped'. */
  const syncOnce = async (force: boolean): Promise<'committed' | 'quiet' | 'skipped'> => {
    if (!force && !inWindow()) return 'skipped';

    const status = await runGit(vaultDataPath, ['status', '--porcelain']);
    if (status.exitCode !== 0) {
      return fail(new Error(`git status failed: ${status.stderr.trim()}`));
    }
    const dirtyLines = status.stdout.split('\n').filter(l => l.length > 0);
    if (dirtyLines.length === 0) {
      clearFailures();
      return 'quiet';
    }

    const subject = commitSubject(dirtyLines.length);
    for (let attempt = 1; ; ++attempt) {
      const add = await runGit(vaultDataPath, ['add', '-A']);
      if (add.exitCode !== 0) {
        if (attempt < MAX_COMMIT_ATTEMPTS && isLockCollision(add.stderr) && removeStaleLock())
          continue;
        return fail(new Error(`git add failed: ${add.stderr.trim()}`));
      }
      const commit = await runGit(vaultDataPath, [...identityArgs, 'commit', '-m', subject]);
      if (commit.exitCode !== 0) {
        // "nothing to commit" can happen if files were only in .gitignore.
        const benign =
          /nothing to commit/i.test(commit.stdout) || /nothing to commit/i.test(commit.stderr);
        if (benign) {
          clearFailures();
          return 'quiet';
        }
        if (
          attempt < MAX_COMMIT_ATTEMPTS &&
          isLockCollision(commit.stderr + commit.stdout) &&
          removeStaleLock()
        )
          continue;
        return fail(new Error(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`));
      }
      break;
    }
    clearFailures();
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
