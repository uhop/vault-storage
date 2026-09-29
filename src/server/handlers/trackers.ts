import {rejectUnknownParams} from '../query.ts';
import {asOf} from '../as-of.ts';
import type {DatabaseSync} from 'node:sqlite';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';
import {projectTrackers} from '../trackers.ts';

interface TrackersDeps {
  db: DatabaseSync;
  vaultDataPath: string;
}

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * GET /projects/{name}/trackers
 *
 * Where the project's work is tracked and which tracker is primary, from the
 * `trackers:` list in its queue.md frontmatter (D95), validated: unknown
 * kinds and malformed entries are dropped and named in `problems`, a second
 * primary is demoted, and no declaration means the vault is primary.
 */
export const projectTrackersHandler =
  (deps: TrackersDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, new Set())) return;
    const project = ctx.params['name'] ?? '';
    if (!PROJECT_NAME_RE.test(project)) {
      sendError(ctx.res, 400, 'bad_request', 'project must be a kebab-case name');
      return;
    }
    sendJson(ctx.res, 200, {...projectTrackers(deps.vaultDataPath, project), as_of: asOf(deps.db)});
  };
