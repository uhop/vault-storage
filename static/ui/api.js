// Shared API helper for all UI pages. Returns the raw `Response` so callers
// pick `.json()` / `.text()` / `.blob()` themselves. Throws on auth and HTTP
// errors so happy-path callers don't repeat status checks.
//
// Errors:
//   - 'no-token'      — bearer not set in localStorage; caller should show
//                       the settings dialog.
//   - 'unauthorized'  — server returned 401; bearer is wrong or expired.
//   - 'not-found'     — server returned 404; caller may special-case this.
//   - <body.error>    — server returned a non-2xx with a JSON `{error: ...}`
//                       body; that string is the message.
//   - 'HTTP <status>' — fallback for non-2xx without a parseable error body.
// Every thrown error past the token check carries `status`, and the body's
// `code` and `details` when it had them, for a caller that handles a conflict.

const TOKEN_KEY = 'vault.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? '';
export const setToken = t => {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
};

// A GET the page's <head> started before the modules loaded, handed over once.
const takeEarly = (path, init) => {
  if ((init.method ?? 'GET') !== 'GET') return undefined;
  const early = globalThis.__early?.get(path);
  globalThis.__early?.delete(path);
  return early;
};

export async function api(path, init = {}) {
  const token = getToken();
  if (!token) throw new Error('no-token');
  const headers = {...(init.headers ?? {}), Authorization: `Bearer ${token}`};
  const res = await (takeEarly(path, init) ?? fetch(path, {...init, headers}));
  if (res.ok) return res;
  let msg = res.status === 401 ? 'unauthorized' : res.status === 404 ? 'not-found' : '';
  let body = null;
  try {
    body = await res.json();
  } catch {}
  if (!msg) msg = body?.error || `HTTP ${res.status}`;
  throw Object.assign(new Error(msg), {
    status: res.status,
    code: body?.code,
    details: body?.details
  });
}

/**
 * Convenience wrapper for the common `await api(...).then(r => r.json())`
 * case. Safe by construction: `api()` throws on non-ok before we get here,
 * so the body is guaranteed parseable.
 */
export const apiJson = (path, init) => api(path, init).then(res => res.json());

const RESOLVE_BATCH = 500;

/**
 * The subset of vault paths (folder-qualified, `projects/x/state.md`) that
 * exist, from batched `POST /resolve`: probing each with a GET answers 404
 * for every missing one, a console error apiece.
 */
export const existingPaths = async paths => {
  const found = new Set();
  for (let i = 0; i < paths.length; i += RESOLVE_BATCH) {
    const chunk = paths.slice(i, i + RESOLVE_BATCH);
    const {items} = await apiJson('/resolve', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({wikilinks: chunk})
    });
    items.forEach((item, j) => {
      if (item.record_id !== null) found.add(chunk[j]);
    });
  }
  return found;
};

/** HTML-escape for interpolating untrusted text into innerHTML templates. */
export const esc = s =>
  String(s).replace(
    /[<>&"']/g,
    c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'})[c]
  );

/**
 * Open the shared settings/auth dialog (`#auth-dlg`), pre-filled with the
 * stored token. Every page ships the same dialog markup; one opener keeps
 * prefill/focus behavior from drifting per page.
 */
export const showAuthDialog = async () => {
  // A page module runs before the <vault-settings> module defines the element
  // that renders the dialog, so a first visit without a token must wait for it.
  if (!document.querySelector('#auth-dlg')) await customElements.whenDefined('vault-settings');
  const dlg = document.querySelector('#auth-dlg');
  if (!dlg) return;
  document.querySelector('#auth-input').value = getToken();
  dlg.showModal();
  document.querySelector('#auth-input').focus();
};
