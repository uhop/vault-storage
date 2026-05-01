// Shared git-process helper. Used by git-sync (auto-commit loop) and
// the incremental-reindex / multi-writer paths.

import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';

export interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const runGit = (cwd: string, args: string[]): Promise<GitResult> =>
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
