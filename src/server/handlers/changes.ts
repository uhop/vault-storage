import type {DatabaseSync} from 'node:sqlite';
import {gitFailure, isGitRepo, runGit} from '../../util/git.ts';
import {asOf} from '../as-of.ts';
import {projectChanges} from '../project-changes.ts';
import {rejectUnknownParams} from '../query.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';
import {parseSince} from './fleet.ts';
import {SHA_RE} from './history.ts';

interface ChangesDeps {
  db: DatabaseSync;
  vaultDataPath: string;
}

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * GET /projects/{name}/changes?since=<ISO|Nd|sha>
 *
 * The project's notes written after `since` and its queue items that entered a
 * section or changed in place (D117). A sha is read as its commit time, which
 * the auto-commit lags behind the edits it records. Answers `{project, since:
 * {date, sha?}, notes, more, queue: {entered, edited, more}, as_of}`.
 */
export const projectChangesHandler =
  (deps: ChangesDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, new Set(['since']))) return;
    const project = ctx.params['name'] ?? '';
    if (!PROJECT_NAME_RE.test(project)) {
      sendError(ctx.res, 400, 'bad_request', 'project must be a kebab-case name');
      return;
    }
    const raw = ctx.query['since'];
    if (raw === undefined) {
      sendError(ctx.res, 400, 'bad_request', 'since is required: an ISO time, Nd, or a sha');
      return;
    }
    let since: {date: string; sha?: string};
    if (SHA_RE.test(raw)) {
      if (!isGitRepo(deps.vaultDataPath)) {
        sendError(ctx.res, 503, 'not_a_git_repo', 'vault data path is not a git repository');
        return;
      }
      const r = await runGit(deps.vaultDataPath, ['show', '-s', '--format=%cI', raw, '--'], {
        timeoutMs: 10_000
      });
      if (r.exitCode !== 0) {
        sendError(ctx.res, 404, 'commit_not_found', `no commit ${raw}: ${gitFailure(r)}`);
        return;
      }
      since = {date: new Date(r.stdout.trim()).toISOString(), sha: raw};
    } else {
      const date = parseSince(raw);
      if (date === null) {
        sendError(ctx.res, 400, 'bad_request', 'since must be an ISO time, Nd, or a sha');
        return;
      }
      since = {date};
    }
    sendJson(ctx.res, 200, {
      project,
      since,
      ...projectChanges(deps.db, project, since.date),
      as_of: asOf(deps.db)
    });
  };
