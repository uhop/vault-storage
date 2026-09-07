// Shared git-process helper. Used by git-sync (auto-commit loop) and
// the incremental-reindex / multi-writer paths.

import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** The child was killed after `timeoutMs`; exitCode is -1 and stderr says so. */
  timedOut?: boolean;
}

/**
 * A git child that never returns holds its caller forever — on 2026-09-07 a
 * `git add -A` sat in uninterruptible sleep on a wedged pool and the sync
 * loop with it. Five minutes is far past any honest git operation here.
 */
export const GIT_TIMEOUT_MS = 5 * 60_000;

export interface RunGitOptions {
  timeoutMs?: number;
  /** The executable; tests substitute one that hangs. */
  bin?: string;
}

export const runGit = (cwd: string, args: string[], opts: RunGitOptions = {}): Promise<GitResult> =>
  new Promise(resolve => {
    const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
    const proc = spawn(opts.bin ?? 'git', args, {cwd, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result: GitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish({
        exitCode: -1,
        stdout,
        stderr: `${stderr}${stderr.length > 0 ? '\n' : ''}timed out after ${timeoutMs} ms`,
        timedOut: true
      });
    }, timeoutMs);
    timer.unref();
    proc.stdout.on('data', d => {
      stdout += d.toString('utf8');
    });
    proc.stderr.on('data', d => {
      stderr += d.toString('utf8');
    });
    proc.on('close', code => finish({exitCode: code ?? -1, stdout, stderr}));
    proc.on('error', err => finish({exitCode: -1, stdout, stderr: String(err)}));
  });

export const isGitRepo = (path: string): boolean =>
  existsSync(join(path, '.git')) || existsSync(join(path, '.git/HEAD'));

/**
 * Resolve `HEAD` to a commit SHA, or null when the path is not a git
 * repo or rev-parse fails. Used to track `meta.last_indexed_commit`
 * alignment with whatever HEAD points at after a pull / commit.
 */
export const getCurrentHead = async (cwd: string): Promise<string | null> => {
  if (!isGitRepo(cwd)) return null;
  const r = await runGit(cwd, ['rev-parse', 'HEAD']);
  if (r.exitCode !== 0) return null;
  const sha = r.stdout.trim();
  return sha.length === 40 ? sha : null;
};
