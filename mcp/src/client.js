// REST client for the vault-storage server. Thin wrapper that prepends the
// configured base URL and `Authorization: Bearer <token>` header to every
// request, normalises errors into a typed shape MCP tool handlers can render
// directly to the agent.

export class VaultClientError extends Error {
  constructor(message, code, status, details = null) {
    super(message);
    this.name = 'VaultClientError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const stripTrailingSlash = s => (s.endsWith('/') ? s.slice(0, -1) : s);

export class VaultClient {
  #apiUrl;
  #apiToken;
  #fetch;

  constructor(config) {
    if (!config.apiUrl) throw new Error('VaultClient: apiUrl is required');
    if (!config.apiToken) throw new Error('VaultClient: apiToken is required');
    this.#apiUrl = stripTrailingSlash(config.apiUrl);
    this.#apiToken = config.apiToken;
    this.#fetch = config.fetchImpl ?? fetch;
  }

  /** Build a full URL from a path + optional query parameters. */
  url(path, query = {}) {
    const normalisedPath = path.startsWith('/') ? path : `/${path}`;
    const u = new URL(`${this.#apiUrl}${normalisedPath}`);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async getJson(path, query = {}) {
    const res = await this.#request('GET', this.url(path, query));
    return this.#parseJson(res);
  }

  async getText(path, query = {}) {
    const res = await this.#request('GET', this.url(path, query));
    if (!res.ok) await this.#throwFromResponse(res);
    return res.text();
  }

  async putJson(path, body) {
    const res = await this.#request('PUT', this.url(path), {
      body: JSON.stringify(body),
      contentType: 'application/json'
    });
    if (res.status === 204) return;
    if (!res.ok) await this.#throwFromResponse(res);
  }

  async deletePath(path) {
    const res = await this.#request('DELETE', this.url(path));
    if (res.status === 204) return;
    if (!res.ok) await this.#throwFromResponse(res);
  }

  async postJson(path, body, query = {}) {
    const init = {};
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.contentType = 'application/json';
    }
    const res = await this.#request('POST', this.url(path, query), init);
    return this.#parseJson(res);
  }

  async #request(method, url, init = {}) {
    const headers = {
      Authorization: `Bearer ${this.#apiToken}`
    };
    if (init.contentType) headers['Content-Type'] = init.contentType;
    try {
      return await this.#fetch(url, {
        method,
        headers,
        body: init.body
      });
    } catch (err) {
      throw new VaultClientError(`network error: ${err.message}`, 'network', 0, {url, method});
    }
  }

  async #parseJson(res) {
    if (!res.ok) await this.#throwFromResponse(res);
    if (res.status === 204) return undefined;
    const text = await res.text();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new VaultClientError(
        `invalid JSON from server: ${err.message}`,
        'invalid_response',
        res.status,
        {raw: text.slice(0, 500)}
      );
    }
  }

  async #throwFromResponse(res) {
    const text = await res.text().catch(() => '');
    let body = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        // Non-JSON error body — keep the raw text in details.
      }
    }
    const code = body?.code ?? this.#defaultCode(res.status);
    const message = body?.error ?? `HTTP ${res.status}`;
    // Normalize `details` to object-or-null: a raw non-JSON body used to
    // leak through as a bare string, giving callers an inconsistent shape.
    const details = body?.details ?? (text.length > 0 ? {raw: text.slice(0, 500)} : null);
    throw new VaultClientError(message, code, res.status, details);
  }

  #defaultCode(status) {
    if (status === 401) return 'auth_failed';
    if (status === 404) return 'not_found';
    if (status === 409) return 'conflict';
    if (status === 422) return 'validation_failed';
    if (status >= 500) return 'internal';
    if (status >= 400) return 'bad_request';
    return 'unknown';
  }
}

/** Read VaultClient config from process.env. Throws if either is missing. */
export const clientFromEnv = () =>
  new VaultClient({
    apiUrl: required('VAULT_API_URL'),
    apiToken: required('VAULT_API_TOKEN')
  });

const required = name => {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`${name} is required (set it in your MCP server configuration's env block)`);
  }
  return v;
};
