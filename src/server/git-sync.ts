// Periodic git auto-commit (and optional push) for the vault content tree.
// Tier 1 backup per C2: while the server is running, pending markdown changes
// land in commits without the user thinking about it.
//
// Design:
//   - Poll every `intervalMs`. Cheap (a `git status --porcelain` runs in
//     low-ms on a few-hundred-file repo).
//   - If the working tree is dirty: `git add -A && git commit -m "<msg>"`.
//   - If `autoPush` is true: `git push` after a successful commit. Failures
//     log but don't crash — push is best-effort.
//   - All git invocations are wrapped: missing git, non-repo, network errors
//     all surface as warnings, not crashes.

import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

export interface GitSyncOptions {
  vaultDataPath: string;
  intervalMs?: number;
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
  log?: (msg: string) => void;
  onError?: (err: unknown) => void;
}

export interface GitSyncHandle {
  /** Trigger a sync now (used on shutdown). */
  syncNow: () => Promise<void>;
  close: () => void;
}

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const runGit = (cwd: string, args: string[]): Promise<GitResult> =>
  new Promise(resolve => {
    const proc = spawn('git', args, {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => {
      stdout += d.toString('utf8');
    });
    proc.stderr.on('data', d => {
      stderr += d.toString('utf8');
    });
    proc.on('close', code => resolve({exitCode: code ?? -1, stdout, stderr}));
    proc.on('error', err => resolve({exitCode: -1, stdout, stderr: String(err)}));
  });

const isGitRepo = (path: string): boolean =>
  existsSync(join(path, '.git')) || existsSync(join(path, '.git/HEAD'));

const defaultSubject = (n: number): string => `vault-storage auto-commit (${n} file${n === 1 ? '' : 's'})`;

export const startGitSync = (opts: GitSyncOptions): GitSyncHandle => {
  const {vaultDataPath} = opts;
  const intervalMs = opts.intervalMs ?? 60_000;
  const autoPush = opts.autoPush ?? false;
  const commitSubject = opts.commitSubject ?? defaultSubject;
  const authorName = opts.authorName ?? 'vault-storage';
  const authorEmail = opts.authorEmail ?? 'vault-storage@localhost';
  const identityArgs = [
    '-c',
    `user.name=${authorName}`,
    '-c',
    `user.email=${authorEmail}`
  ];
  const log = opts.log ?? (msg => process.stdout.write(`vault-storage: ${msg}\n`));
  const onError =
    opts.onError ?? (err => process.stderr.write(`git-sync: ${err instanceof Error ? err.message : String(err)}\n`));

  if (!isGitRepo(vaultDataPath)) {
    log(`git-sync: ${vaultDataPath} is not a git repo, auto-commit disabled`);
    return {syncNow: async () => {}, close: () => {}};
  }

  let inFlight: Promise<void> = Promise.resolve();

  const syncOnce = async (): Promise<void> => {
    const status = await runGit(vaultDataPath, ['status', '--porcelain']);
    if (status.exitCode !== 0) {
      onError(new Error(`git status failed: ${status.stderr.trim()}`));
      return;
    }
    const dirtyLines = status.stdout.split('\n').filter(l => l.length > 0);
    if (dirtyLines.length === 0) return;

    const add = await runGit(vaultDataPath, ['add', '-A']);
    if (add.exitCode !== 0) {
      onError(new Error(`git add failed: ${add.stderr.trim()}`));
      return;
    }
    const subject = commitSubject(dirtyLines.length);
    const commit = await runGit(vaultDataPath, [...identityArgs, 'commit', '-m', subject]);
    if (commit.exitCode !== 0) {
      // "nothing to commit" can happen if files were only in .gitignore.
      const benign = /nothing to commit/i.test(commit.stdout) || /nothing to commit/i.test(commit.stderr);
      if (!benign) onError(new Error(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`));
      return;
    }
    log(`git-sync: committed ${dirtyLines.length} change(s)`);

    if (autoPush) {
      const push = await runGit(vaultDataPath, ['push']);
      if (push.exitCode !== 0) {
        onError(new Error(`git push failed: ${push.stderr.trim()}`));
        return;
      }
      log('git-sync: pushed to remote');
    }
  };

  const enqueueSync = (): void => {
    inFlight = inFlight.then(syncOnce).catch(err => onError(err));
  };

  const timer = setInterval(enqueueSync, intervalMs);

  return {
    async syncNow() {
      enqueueSync();
      await inFlight;
    },
    close() {
      clearInterval(timer);
    }
  };
};
