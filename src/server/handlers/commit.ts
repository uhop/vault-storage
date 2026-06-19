import type {DatabaseSync} from 'node:sqlite';
import {setLastIndexedCommit} from '../../maintenance/incremental-reindex.ts';
import {getCurrentHead, isGitRepo, runGit} from '../../util/git.ts';
import {readBodyText} from '../body.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

interface CommitDeps {
  db: DatabaseSync;
  vaultDataPath: string;
  authorName: string;
  authorEmail: string;
}

interface CommitRequest {
  message?: string;
  paths?: string[];
}

const defaultMessage = (n: number): string =>
  `vault-storage manual commit (${n} file${n === 1 ? '' : 's'})`;

const SUBJECT_MAX = 200;

/**
 * POST /commit — agent-driven explicit commit boundary.
 *
 * Body: `{message?: string, paths?: string[]}`.
 *
 * Stages and commits pending changes with `record_id`-preserving identity
 * args (`-c user.name=… -c user.email=…`) so containers without a global
 * gitconfig still attribute correctly. When `paths` is omitted, runs
 * `git add -A`; when supplied, runs `git add <paths...>` against just
 * those paths (vault-relative). When `message` is omitted, generates a
 * default like `vault-storage manual commit (N files)`.
 *
 * Use cases:
 *   - Agent wraps a multi-file batch (enrichment, compaction archive,
 *     bulk tag promotion) in a single semantic commit.
 *   - Multi-writer git workflow: agent commits explicitly before a push.
 *
 * After a successful commit, advances `meta.last_indexed_commit` to the
 * new HEAD so the post-pull incremental-reindex anchor stays coherent.
 *
 * Returns 200 with one of:
 *   - `{committed: true, sha, files, message, durationMs}` on success.
 *   - `{committed: false, reason: 'nothing-to-commit', durationMs}` when
 *     the working tree is clean (or `paths` are all clean).
 *
 * Errors:
 *   - 400 on malformed body, empty `paths`, message > 200 chars, or path
 *     traversal attempts (`..`).
 *   - 503 when the vault is not a git repository.
 *   - 500 on unexpected git failures (status / add / commit).
 */
export const commitHandler =
  (deps: CommitDeps): Handler =>
  async ctx => {
    const start = Date.now();

    if (!isGitRepo(deps.vaultDataPath)) {
      sendError(ctx.res, 503, 'not_a_git_repo', 'vault data path is not a git repository');
      return;
    }

    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }

    let body: CommitRequest = {};
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw) as CommitRequest;
      } catch {
        sendError(ctx.res, 400, 'invalid_json', 'request body must be JSON');
        return;
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        sendError(ctx.res, 400, 'invalid_request', 'body must be a JSON object');
        return;
      }
    }

    if (body.message !== undefined) {
      if (typeof body.message !== 'string') {
        sendError(ctx.res, 400, 'invalid_request', 'message must be a string');
        return;
      }
      if (body.message.length > SUBJECT_MAX) {
        sendError(ctx.res, 400, 'invalid_request', `message must be ≤ ${SUBJECT_MAX} chars`);
        return;
      }
    }

    if (body.paths !== undefined) {
      if (!Array.isArray(body.paths) || body.paths.length === 0) {
        sendError(ctx.res, 400, 'invalid_request', 'paths must be a non-empty array of strings');
        return;
      }
      for (const p of body.paths) {
        if (typeof p !== 'string' || p.length === 0) {
          sendError(ctx.res, 400, 'invalid_request', 'each path must be a non-empty string');
          return;
        }
        // Reject obvious traversal; vault-relative paths only.
        if (p.includes('..') || p.startsWith('/')) {
          sendError(
            ctx.res,
            400,
            'invalid_path',
            `path must be vault-relative, no .. or leading /: ${p}`
          );
          return;
        }
      }
    }

    // Status — what's dirty?
    const status = await runGit(deps.vaultDataPath, ['status', '--porcelain']);
    if (status.exitCode !== 0) {
      sendError(ctx.res, 500, 'git_status_failed', status.stderr.trim() || status.stdout.trim());
      return;
    }
    const dirtyLines = status.stdout.split('\n').filter(l => l.length > 0);
    if (dirtyLines.length === 0) {
      sendJson(ctx.res, 200, {
        committed: false,
        reason: 'nothing-to-commit',
        durationMs: Date.now() - start
      });
      return;
    }

    // Add — either everything or just the requested paths.
    const addArgs = body.paths ? ['add', '--', ...body.paths] : ['add', '-A'];
    const add = await runGit(deps.vaultDataPath, addArgs);
    if (add.exitCode !== 0) {
      sendError(ctx.res, 500, 'git_add_failed', add.stderr.trim() || add.stdout.trim());
      return;
    }

    // Re-check status: with `paths`, the staged set may be empty even if the
    // working tree has unrelated dirty files. With `-A`, it should match the
    // dirty count we just measured (modulo .gitignore'd paths).
    const staged = await runGit(deps.vaultDataPath, ['diff', '--cached', '--name-only']);
    if (staged.exitCode !== 0) {
      sendError(ctx.res, 500, 'git_diff_failed', staged.stderr.trim() || staged.stdout.trim());
      return;
    }
    const stagedFiles = staged.stdout.split('\n').filter(l => l.length > 0);
    if (stagedFiles.length === 0) {
      sendJson(ctx.res, 200, {
        committed: false,
        reason: 'nothing-to-commit',
        durationMs: Date.now() - start
      });
      return;
    }

    const message = body.message ?? defaultMessage(stagedFiles.length);
    const identityArgs = [
      '-c',
      `user.name=${deps.authorName}`,
      '-c',
      `user.email=${deps.authorEmail}`
    ];
    const commit = await runGit(deps.vaultDataPath, [...identityArgs, 'commit', '-m', message]);
    if (commit.exitCode !== 0) {
      const benign =
        /nothing to commit/i.test(commit.stdout) || /nothing to commit/i.test(commit.stderr);
      if (benign) {
        sendJson(ctx.res, 200, {
          committed: false,
          reason: 'nothing-to-commit',
          durationMs: Date.now() - start
        });
        return;
      }
      sendError(ctx.res, 500, 'git_commit_failed', commit.stderr.trim() || commit.stdout.trim());
      return;
    }

    const sha = await getCurrentHead(deps.vaultDataPath);
    if (sha) setLastIndexedCommit(deps.db, sha);

    sendJson(ctx.res, 200, {
      committed: true,
      sha,
      files: stagedFiles,
      message,
      durationMs: Date.now() - start
    });
  };
