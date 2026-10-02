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
//   - If the working tree is dirty: `git add -A`, then one commit per named
//     writer of the staged paths, authored by that writer with a `Key:`
//     trailer (D136), and one for the rest under the configured author.
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

import {rmSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {setLastIndexedCommit} from '../maintenance/incremental-reindex.ts';
import {getCurrentHead, gitFailure, isGitRepo, runGit, type GitResult} from '../util/git.ts';
import {exportVaultState} from '../vault-state.ts';
import type {HealthMonitor} from './health.ts';
import {prepared} from '../db/prepared.ts';
import {clearWriters, dropStaleWriters, writersOf, type Writer} from './writers.ts';

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
  /** Outcomes reported for /system/health; a git child past its timeout marks the loop stalled. */
  health?: HealthMonitor;
}

export interface GitSyncHandle {
  /** Trigger a sync now (used on shutdown). */
  syncNow: () => Promise<void>;
  close: () => void;
}

const defaultSubject = (n: number): string =>
  `vault-storage auto-commit (${n} file${n === 1 ? '' : 's'})`;

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

// "nothing to commit": only ignored files changed, or another commit took the paths.
const nothingToCommit = (r: GitResult): boolean =>
  /nothing to commit|no changes added to commit/i.test(r.stdout + r.stderr);

/** The staged paths of each named writer, one group per key. */
const groupByWriter = (writers: Map<string, Writer>): {writer: Writer; paths: string[]}[] => {
  const groups = new Map<string, {writer: Writer; paths: string[]}>();
  for (const [path, writer] of writers) {
    const group = groups.get(writer.key_id);
    if (group) group.paths.push(path);
    else groups.set(writer.key_id, {writer, paths: [path]});
  }
  return [...groups.values()];
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
    const row = prepared(
      opts.db,
      `SELECT value FROM meta WHERE key = 'git_sync_consecutive_failures'`
    ).get() as {value?: string} | undefined;
    const prior = Number(row?.value ?? '0');
    const upsert = prepared(opts.db, 'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    upsert.run('git_sync_consecutive_failures', String((Number.isFinite(prior) ? prior : 0) + 1));
    upsert.run('git_sync_last_error', message);
    const since = prepared(
      opts.db,
      `SELECT value FROM meta WHERE key = 'git_sync_failing_since'`
    ).get();
    if (!since) upsert.run('git_sync_failing_since', now().toISOString());
  };

  const clearFailures = (): void => {
    opts.health?.recordGitSync({ok: true});
    if (!opts.db) return;
    prepared(opts.db, `DELETE FROM meta WHERE key IN ${FAILURE_META_KEYS}`).run();
  };

  // Whether the most recent git child was killed by its timeout — what turns
  // a plain failure into a stall verdict on /system/health.
  let lastTimedOut = false;
  const git = async (args: string[]): Promise<GitResult> => {
    const result = await runGit(vaultDataPath, args);
    lastTimedOut = result.timedOut === true;
    return result;
  };

  /** Ledger + warning in one step; always resolves the poll as 'quiet'. */
  const fail = (err: Error): 'quiet' => {
    recordFailure(err.message);
    opts.health?.recordGitSync({ok: false, error: err.message, timedOut: lastTimedOut});
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

  /** `git` once more after a lock collision whose lock was stale. */
  const gitRetrying = async (args: string[]): Promise<GitResult> => {
    const first = await git(args);
    if (first.exitCode === 0 || !isLockCollision(first.stderr + first.stdout)) return first;
    return removeStaleLock() ? git(args) : first;
  };

  /** Returns 'committed', 'quiet', or 'skipped'. */
  const syncOnce = async (force: boolean): Promise<'committed' | 'quiet' | 'skipped'> => {
    if (!force && !inWindow()) return 'skipped';

    // The database-only state rides in the commit with the content it belongs to (D121).
    if (opts.db) {
      try {
        await exportVaultState(opts.db, vaultDataPath);
      } catch (err) {
        log(`git-sync: state export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const status = await git(['status', '--porcelain']);
    if (status.exitCode !== 0) {
      return fail(new Error(`git status failed: ${gitFailure(status)}`));
    }
    const dirtyLines = status.stdout.split('\n').filter(l => l.length > 0);
    if (dirtyLines.length === 0) {
      clearFailures();
      return 'quiet';
    }

    const passStart = new Date().toISOString();
    const add = await gitRetrying(['add', '-A']);
    if (add.exitCode !== 0) return fail(new Error(`git add failed: ${gitFailure(add)}`));

    let staged: string[] = [];
    let groups: {writer: Writer; paths: string[]}[] = [];
    if (opts.db) {
      const diff = await git(['diff', '--cached', '--name-only', '--no-renames', '-z']);
      if (diff.exitCode !== 0) return fail(new Error(`git diff failed: ${gitFailure(diff)}`));
      staged = diff.stdout.split('\0').filter(p => p.length > 0);
      groups = groupByWriter(writersOf(opts.db, staged));
    }

    // Each named writer's paths first, under that writer's name; the rest under the configured author.
    let commits = 0;
    for (const {writer, paths} of groups) {
      const pathspec = join(vaultDataPath, '.git', 'vault-storage-pathspec');
      writeFileSync(pathspec, paths.join('\0'));
      const commit = await gitRetrying([
        ...identityArgs,
        '--literal-pathspecs',
        'commit',
        '--only',
        `--author=${writer.name} <${writer.email ?? authorEmail}>`,
        '-m',
        commitSubject(paths.length),
        '-m',
        `Key: ${writer.name} (${writer.kind}, ${writer.key_id})`,
        `--pathspec-from-file=${pathspec}`,
        '--pathspec-file-nul'
      ]);
      rmSync(pathspec, {force: true});
      if (commit.exitCode === 0) ++commits;
      else if (!nothingToCommit(commit))
        return fail(new Error(`git commit failed: ${gitFailure(commit)}`));
    }
    const grouped = groups.reduce((n, g) => n + g.paths.length, 0);
    const rest = await gitRetrying([
      ...identityArgs,
      'commit',
      '-m',
      commitSubject(opts.db ? staged.length - grouped : dirtyLines.length)
    ]);
    if (rest.exitCode === 0) ++commits;
    else if (!nothingToCommit(rest))
      return fail(new Error(`git commit failed: ${gitFailure(rest)}`));
    if (opts.db) {
      clearWriters(opts.db, staged, passStart);
      dropStaleWriters(opts.db, new Set(staged), passStart);
    }
    if (commits === 0) {
      clearFailures();
      return 'quiet';
    }
    clearFailures();
    log(
      `git-sync: committed ${dirtyLines.length} change(s)${commits > 1 ? ` in ${commits} commits` : ''}`
    );

    // Advance the multi-writer reindex anchor so a later post-pull diff
    // sees a coherent `last_indexed_commit..HEAD` range. The watcher
    // already imported the file changes that produced this commit; we
    // just need the anchor to track HEAD.
    if (opts.db) {
      const head = await getCurrentHead(vaultDataPath);
      if (head) setLastIndexedCommit(opts.db, head);
    }

    if (autoPush) {
      const push = await git(['push']);
      if (push.exitCode !== 0) {
        onError(new Error(`git push failed: ${gitFailure(push)}`));
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
