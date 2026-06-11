import type {ResolverCache} from '../resolver-cache.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

interface ResolveDeps {
  resolverCache: ResolverCache;
}

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
 * `ui_url` points at the note editor (`/ui/note.html?path=…`). The UI's
 * preview pane reads it to populate `<a class="wikilink">` href attributes
 * so clicking a rendered wikilink navigates like a native link (including
 * middle-click and cmd/ctrl-click for new-tab semantics).
 */
export const resolveHandler =
  (deps: ResolveDeps): Handler =>
  ctx => {
    const link = ctx.query['wikilink'];
    if (typeof link !== 'string' || link.trim().length === 0) {
      sendError(ctx.res, 400, 'invalid_request', 'wikilink query param is required and non-empty');
      return;
    }
    // Cached path-only view — the UI preview calls /resolve once per
    // wikilink in a note, and a fresh full-record load per call was the
    // hottest per-request cost on the read path. Import paths invalidate.
    const {resolver, pathById} = deps.resolverCache.get();
    const recordId = resolver.resolve(link);
    if (!recordId) {
      sendError(ctx.res, 404, 'not_found', `wikilink not resolved: ${link}`);
      return;
    }
    const filePath = pathById.get(recordId);
    if (filePath === undefined) {
      sendError(ctx.res, 404, 'not_found', `record not found for id ${recordId}`);
      return;
    }
    sendJson(ctx.res, 200, {
      target: link,
      record_id: recordId,
      file_path: filePath,
      ui_url: `/ui/note.html?path=${encodeURIComponent(filePath)}`
    });
  };
