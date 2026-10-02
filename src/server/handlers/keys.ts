// The named-key routes (D135). Creating, listing, and recalling keys are a
// person's acts; GET /keys/me answers any key with the caller's own session.

import {readJsonBody} from '../body.ts';
import {KEY_KINDS, requirePerson, type KeyKind, type KeyStore} from '../keys.ts';
import {NO_QUERY_PARAMS, rejectUnknownParams} from '../query.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

interface KeyDeps {
  keys: KeyStore;
}

const noStore = (ctx: Parameters<Handler>[0]): void =>
  sendError(
    ctx.res,
    409,
    'no_key_file',
    'no key file is configured (VAULT_KEYS_PATH); only VAULT_API_TOKEN is accepted'
  );

/** GET /keys/me — the caller's own key: {key_id, name, kind, email}. */
export const keysMeHandler = (): Handler => ctx => {
  if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
  sendJson(ctx.res, 200, ctx.session ?? null);
};

/** GET /keys — every key in the file with its status, never its hash: {items}. */
export const listKeysHandler =
  (deps: KeyDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    if (!requirePerson(ctx, 'listing keys')) return;
    sendJson(ctx.res, 200, {items: deps.keys.list()});
  };

/** POST /keys {name, kind, email?, expires_at?} — a new key; the secret is in this answer only. */
export const createKeyHandler =
  (deps: KeyDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    if (!requirePerson(ctx, 'creating a key')) return;
    if (deps.keys.path === null) {
      noStore(ctx);
      return;
    }
    const parsed = await readJsonBody(ctx);
    if (!parsed) return;
    const {name, kind, email, expires_at} = parsed.body;
    if (typeof name !== 'string' || name.trim().length === 0) {
      sendError(ctx.res, 400, 'bad_request', 'name must be a non-empty string');
      return;
    }
    if (!KEY_KINDS.includes(kind as KeyKind)) {
      sendError(
        ctx.res,
        400,
        'invalid_enum_value',
        `kind must be one of ${KEY_KINDS.join(', ')}; got ${JSON.stringify(kind)}`
      );
      return;
    }
    if (email !== undefined && email !== null && typeof email !== 'string') {
      sendError(ctx.res, 400, 'bad_request', 'email must be a string when set');
      return;
    }
    if (
      expires_at !== undefined &&
      expires_at !== null &&
      (typeof expires_at !== 'string' || Number.isNaN(Date.parse(expires_at)))
    ) {
      sendError(ctx.res, 400, 'bad_request', 'expires_at must be an ISO date or time when set');
      return;
    }
    const created = deps.keys.create({
      name: name.trim(),
      kind: kind as KeyKind,
      email: typeof email === 'string' && email.length > 0 ? email : null,
      expires_at: typeof expires_at === 'string' ? new Date(expires_at).toISOString() : null
    });
    sendJson(ctx.res, 201, created);
  };

/** POST /keys/{id}/recall — the key stops working at once; recalling twice is a no-op. */
export const recallKeyHandler =
  (deps: KeyDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    if (!requirePerson(ctx, 'recalling a key')) return;
    if (deps.keys.path === null) {
      noStore(ctx);
      return;
    }
    const key = deps.keys.recall(ctx.params['id'] ?? '');
    if (key === null) {
      sendError(ctx.res, 404, 'not_found', `no key ${ctx.params['id']}`);
      return;
    }
    sendJson(ctx.res, 200, {key});
  };
