import {noteUiUrl} from '../../render/render.ts';
import {readBodyText} from '../body.ts';
import {NO_QUERY_PARAMS, rejectUnknownParams} from '../query.ts';
import type {ResolvedView, ResolverCache} from '../resolver-cache.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

interface ResolveDeps {
  resolverCache: ResolverCache;
}

interface Resolved {
  target: string;
  record_id: string;
  file_path: string;
  ui_url: string;
}

const MAX_BATCH = 500;

const isWikilink = (link: unknown): link is string =>
  typeof link === 'string' && link.trim().length > 0;

const lookup = ({resolver, pathById}: ResolvedView, link: string): Resolved | null => {
  const recordId = resolver.resolve(link);
  if (recordId === null) return null;
  const filePath = pathById.get(recordId);
  if (filePath === undefined) return null;
  return {
    target: link,
    record_id: recordId,
    file_path: filePath,
    ui_url: noteUiUrl(filePath)
  };
};

/**
 * GET /resolve?wikilink=<text>
 *
 * Resolve wikilink text (`topics/foo`, `foo`, `Page#section`, etc.) to a
 * record. Uses the same resolution logic as the body-wikilink classifier
 * (see `src/importer/resolver.ts`): exact path → path-plus-`.md` → unique
 * basename → folder `_about.md` fallback. `#anchor` suffix is stripped
 * before lookup; anchors are orthogonal to record identity.
 *
 * Returns 200 with `{target, record_id, file_path, ui_url}` on resolution,
 * 404 when no record matches, 400 when wikilink param is missing/empty.
 *
 * `ui_url` points at the note page (`/ui/note.html?path=…`), which shows the
 * note rendered. The edit page's preview reads it to populate
 * `<a class="wikilink">` href attributes so clicking a rendered wikilink
 * navigates like a native link (including middle-click and cmd/ctrl-click
 * for new-tab semantics).
 */
export const resolveHandler =
  (deps: ResolveDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, new Set(['wikilink']))) return;
    const link = ctx.query['wikilink'];
    if (!isWikilink(link)) {
      sendError(ctx.res, 400, 'invalid_request', 'wikilink query param is required and non-empty');
      return;
    }
    // Cached path-only view: a fresh full-record load per call was the
    // hottest per-request cost on the read path. Import paths invalidate.
    const hit = lookup(deps.resolverCache.get(), link);
    if (hit === null) {
      sendError(ctx.res, 404, 'not_found', `wikilink not resolved: ${link}`);
      return;
    }
    sendJson(ctx.res, 200, hit);
  };

const parseBatch = (raw: string): string[] | string => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'body must be JSON';
  }
  const links = (parsed as {wikilinks?: unknown} | null)?.wikilinks;
  if (!Array.isArray(links)) return 'wikilinks must be an array';
  if (links.length > MAX_BATCH)
    return `wikilinks holds ${links.length} entries; the limit is ${MAX_BATCH}`;
  if (!links.every(isWikilink)) return 'wikilinks must be non-empty strings';
  return links;
};

/**
 * POST /resolve — body `{wikilinks: string[]}`, at most 500 entries.
 *
 * Resolves every entry by the GET rules and answers `{items}` in request
 * order: a hit is the GET's `{target, record_id, file_path, ui_url}`, a
 * miss is `{target, record_id: null, file_path: null, ui_url: null}`. The
 * edit page's preview sends a rendered note's distinct wikilinks in one request;
 * one GET per link was 145 round trips on a 900 KB note (2026-09-17).
 */
export const resolveBatchHandler =
  (deps: ResolveDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }
    const links = parseBatch(raw);
    if (typeof links === 'string') {
      sendError(ctx.res, 400, 'invalid_request', links);
      return;
    }
    const view = deps.resolverCache.get();
    const items = links.map(
      link => lookup(view, link) ?? {target: link, record_id: null, file_path: null, ui_url: null}
    );
    sendJson(ctx.res, 200, {items});
  };
