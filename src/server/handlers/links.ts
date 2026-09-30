import type {DatabaseSync} from 'node:sqlite';
import {ExternalLinksRepository, linkKey, normalizeKey} from '../../links/external.ts';
import {asOf} from '../as-of.ts';
import {rejectUnknownParams} from '../query.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

interface LinksDeps {
  db: DatabaseSync;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * GET /links?key=<key> | ?url=<url> | ?repo=<owner/name>
 *
 * The index of external links (D112): the notes that mention an outside
 * object, each with the queue items that hold the mention. `key` is the
 * object in `source:` spelling (`github uhop/x#5`, `figma <file>`,
 * `url <normalized>`); `url` is any http(s) URL, keyed as the index keys it;
 * `repo` answers every thread of a GitHub repository at once. A bare `#5` in
 * a project's note counts toward the repository its project resolves to.
 */
export const linksHandler =
  (deps: LinksDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, new Set(['key', 'url', 'repo']))) return;
    const {key, url, repo} = ctx.query;
    const given = [key, url, repo].filter(v => v !== undefined).length;
    if (given !== 1) {
      sendError(ctx.res, 400, 'bad_request', 'pass exactly one of key, url, or repo');
      return;
    }
    const links = new ExternalLinksRepository(deps.db);
    if (repo !== undefined) {
      if (!REPO_RE.test(repo)) {
        sendError(ctx.res, 400, 'bad_request', 'repo must be owner/name');
        return;
      }
      sendJson(ctx.res, 200, {repo, links: links.byRepo(repo), as_of: asOf(deps.db)});
      return;
    }
    const lookup = url === undefined ? normalizeKey(key!) : linkKey(url);
    if (lookup === null || lookup.length === 0) {
      sendError(
        ctx.res,
        400,
        'bad_request',
        url === undefined ? 'key is empty' : 'url must be an http(s) URL'
      );
      return;
    }
    sendJson(ctx.res, 200, {
      ...(url === undefined ? {} : {url}),
      key: lookup,
      links: [links.byKey(lookup)],
      as_of: asOf(deps.db)
    });
  };
