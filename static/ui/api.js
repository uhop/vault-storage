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

const TOKEN_KEY = 'vault.token';

export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? '';
export const setToken = t => {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
};

export async function api(path, init = {}) {
  const token = getToken();
  if (!token) throw new Error('no-token');
  const headers = {...(init.headers ?? {}), Authorization: `Bearer ${token}`};
  const res = await fetch(path, {...init, headers});
  if (res.status === 401) throw new Error('unauthorized');
  if (res.status === 404) throw new Error('not-found');
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {}
    throw new Error(msg);
  }
  return res;
}

/**
 * Convenience wrapper for the common `await api(...).then(r => r.json())`
 * case. Safe by construction: `api()` throws on non-ok before we get here,
 * so the body is guaranteed parseable.
 */
export const apiJson = (path, init) => api(path, init).then(res => res.json());
