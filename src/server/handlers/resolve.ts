import type {DatabaseSync} from 'node:sqlite';
import {WikilinkResolver} from '../../importer/resolver.ts';
import {RecordsRepository} from '../../records/repository.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

interface ResolveDeps {
  db: DatabaseSync;
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
    const records = new RecordsRepository(deps.db).listAll();
    const resolver = new WikilinkResolver(records);
    const recordId = resolver.resolve(link);
    if (!recordId) {
      sendError(ctx.res, 404, 'not_found', `wikilink not resolved: ${link}`);
      return;
    }
    const record = records.find(r => r.recordId === recordId);
    if (!record) {
      sendError(ctx.res, 404, 'not_found', `record not found for id ${recordId}`);
      return;
    }
    sendJson(ctx.res, 200, {
      target: link,
      record_id: recordId,
      file_path: record.filePath,
      ui_url: `/ui/note.html?path=${encodeURIComponent(record.filePath)}`
    });
  };
