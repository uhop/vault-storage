import {HEADING_LINE_RE} from '../../markdown/sections.ts';
import {readBodyText} from '../body.ts';
import {DRAFT_ID_RE, type DraftStore, type DraftUnit} from '../drafts.ts';
import {NO_QUERY_PARAMS, rejectUnknownParams} from '../query.ts';
import {sendError, sendJson, sendNoContent} from '../responses.ts';
import type {Handler} from '../router.ts';
import {ensureSafePath, WriterError} from '../writer.ts';

interface DraftDeps {
  drafts: DraftStore;
  vaultDataPath: string;
}

const unitOf = (raw: unknown): DraftUnit | string => {
  const u = raw as {kind?: unknown; heading?: unknown; occurrence?: unknown} | null;
  if (u?.kind === 'document' || u?.kind === 'frontmatter') return {kind: u.kind};
  if (u?.kind !== 'section') return 'unit.kind must be "document", "frontmatter", or "section"';
  if (typeof u.heading !== 'string' || !HEADING_LINE_RE.test(u.heading.trim()))
    return 'a section unit needs `heading`, an ATX heading line such as "## Title"';
  if (typeof u.occurrence !== 'number' || !Number.isSafeInteger(u.occurrence) || u.occurrence < 0)
    return 'a section unit needs `occurrence`, a non-negative integer';
  return {kind: 'section', heading: u.heading.trim(), occurrence: u.occurrence};
};

/**
 * GET /drafts[?path=] — unsaved edits kept for the UI's editor, every one or
 * those for one note, the most recently saved first: flat `{count, items}`,
 * each item `{id, path, unit, base_hash, text, updated}`.
 */
export const listDraftsHandler =
  (deps: DraftDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, new Set(['path']))) return;
    const items = await deps.drafts.list(ctx.query['path']);
    sendJson(ctx.res, 200, {count: items.length, items});
  };

/**
 * PUT /drafts — body `{path, unit, base_hash, text}` saves the draft of one
 * note's unit (`{kind: "document"}`, `{kind: "frontmatter"}`, or
 * `{kind: "section", heading, occurrence}`), replacing any earlier one.
 * `base_hash` is the hash the unit's text had when editing began, as the
 * section and frontmatter reads return it. Answers the draft without its text.
 */
export const putDraftHandler =
  (deps: DraftDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }
    let req: {path?: unknown; unit?: unknown; base_hash?: unknown; text?: unknown};
    try {
      req = JSON.parse(raw) ?? {};
    } catch {
      sendError(ctx.res, 400, 'bad_request', 'body must be JSON');
      return;
    }
    const {path, base_hash: baseHash, text} = req;
    if (typeof path !== 'string' || !path.endsWith('.md')) {
      sendError(ctx.res, 400, 'invalid_path', 'path must be a vault-relative .md path');
      return;
    }
    try {
      ensureSafePath(deps.vaultDataPath, path);
    } catch (err) {
      if (!(err instanceof WriterError)) throw err;
      sendError(ctx.res, err.status, err.code, err.message);
      return;
    }
    const unit = unitOf(req.unit);
    if (typeof unit === 'string') {
      sendError(ctx.res, 400, 'bad_request', unit);
      return;
    }
    if (typeof baseHash !== 'string' || typeof text !== 'string') {
      sendError(ctx.res, 400, 'bad_request', '`base_hash` and `text` must be strings');
      return;
    }
    const saved = await deps.drafts.put({path, unit, base_hash: baseHash, text});
    sendJson(ctx.res, 200, {
      id: saved.id,
      path: saved.path,
      unit: saved.unit,
      base_hash: saved.base_hash,
      updated: saved.updated
    });
  };

/** DELETE /drafts/{id} — discard a draft; 404 when there is none. */
export const deleteDraftHandler =
  (deps: DraftDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const id = ctx.params['id'] ?? '';
    if (!DRAFT_ID_RE.test(id) || !(await deps.drafts.remove(id))) {
      sendError(ctx.res, 404, 'not_found', `no draft ${id}`);
      return;
    }
    sendNoContent(ctx.res);
  };
