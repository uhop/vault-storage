// REST client for the vault-storage server. Thin wrapper that prepends the
// configured base URL and `Authorization: Bearer <token>` header to every
// request, normalises errors into a typed shape MCP tool handlers can render
// directly to the agent.

export class VaultClientError extends Error {
  constructor(message, code, status, details = null, options = undefined) {
    super(message, options);
    this.name = 'VaultClientError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const stripTrailingSlash = s => (s.endsWith('/') ? s.slice(0, -1) : s);

// A restart takes about two seconds (measured on a deploy); an even step finds the server soon after.
const RETRY_DELAYS_MS = new Array(16).fill(500);
// The connection opened and then dropped or went quiet: the request went out.
const DROPPED = new Set([
  'UND_ERR_SOCKET',
  'ECONNRESET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT'
]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const networkError = (err, cause, method, url, attempts) => {
  let message = `network error: ${err.message}`;
  if (cause) message += ` (${cause})`;
  if (cause === 'ECONNREFUSED') {
    message += '; nothing listens there, so the request was not sent';
  } else if (method !== 'GET' && DROPPED.has(cause)) {
    message +=
      '; the connection dropped after the request went out, so the write may have applied: read the document before repeating it';
  }
  return new VaultClientError(message, 'network', 0, {url, method, cause, attempts}, {cause: err});
};

/** Fallback codes for responses whose body carried no `code` of its own. */
const STATUS_CODES = {
  401: 'auth_failed',
  404: 'not_found',
  409: 'conflict',
  412: 'precondition_failed',
  422: 'validation_failed'
};

export class VaultClient {
  #apiUrl;
  #apiToken;
  #fetch;
  #retryDelays;

  constructor(config) {
    if (!config.apiUrl) throw new Error('VaultClient: apiUrl is required');
    if (!config.apiToken) throw new Error('VaultClient: apiToken is required');
    this.#apiUrl = stripTrailingSlash(config.apiUrl);
    this.#apiToken = config.apiToken;
    this.#fetch = config.fetchImpl ?? fetch;
    this.#retryDelays = config.retryDelaysMs ?? RETRY_DELAYS_MS;
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

  /**
   * `getText` plus the concurrency metadata a conditional write needs: the
   * `ETag` to send back as `If-Match`, and `composed` for the atomized-folder
   * view, whose weak tag can never satisfy If-Match's strong comparison.
   */
  async getTextWithMeta(path, query = {}) {
    const res = await this.#request('GET', this.url(path, query));
    if (!res.ok) await this.#throwFromResponse(res);
    // A compressed read's tag carries its coding (server D70); the document's tag has none.
    const etag = res.headers.get('etag')?.replace(/-(?:zstd|br|gzip)"$/, '"') ?? null;
    return {
      text: await res.text(),
      etag,
      composed: res.headers.get('x-vault-composed') === 'true' || Boolean(etag?.startsWith('W/'))
    };
  }

  /** Raw bytes back, for artifacts that are not JSON or markdown. */
  async getBuffer(path, query = {}) {
    const res = await this.#request('GET', this.url(path, query));
    if (!res.ok) await this.#throwFromResponse(res);
    return Buffer.from(await res.arrayBuffer());
  }

  /** Raw-body PUT (spool artifacts); the server parses no JSON here. */
  async putRaw(path, query, body, contentType) {
    const res = await this.#request('PUT', this.url(path, query), {body, contentType});
    return this.#parseJson(res);
  }

  async putJson(path, body, {ifMatch} = {}) {
    const res = await this.#request('PUT', this.url(path), {
      body: JSON.stringify(body),
      contentType: 'application/json',
      ...(ifMatch ? {headers: {'If-Match': ifMatch}} : {})
    });
    if (!res.ok && res.status !== 204) await this.#throwFromResponse(res);
    // A write with unknown tags answers 200 with a body beside the ETag.
    const answered =
      res.status === 200 && (res.headers.get('content-type') ?? '').includes('application/json')
        ? await res.json()
        : {};
    return {...answered, etag: res.headers.get('etag')};
  }

  async patchJson(path, body) {
    const res = await this.#request('PATCH', this.url(path), {
      body: JSON.stringify(body),
      contentType: 'application/json'
    });
    return this.#parseJson(res);
  }

  async deletePath(path) {
    const res = await this.#request('DELETE', this.url(path));
    if (res.status === 204) return;
    if (!res.ok) await this.#throwFromResponse(res);
  }

  /** A DELETE whose route answers with a JSON body. */
  async deleteJson(path) {
    return this.#parseJson(await this.#request('DELETE', this.url(path)));
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

  /** `postJson` plus the response headers, for a route that stamps `as_of` there. */
  async postJsonWithMeta(path, body, query = {}) {
    const init = {};
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.contentType = 'application/json';
    }
    const res = await this.#request('POST', this.url(path, query), init);
    const json = await this.#parseJson(res);
    return {json, headers: res.headers};
  }

  async #request(method, url, init = {}) {
    const headers = {
      Authorization: `Bearer ${this.#apiToken}`,
      ...init.headers
    };
    if (init.contentType) headers['Content-Type'] = init.contentType;
    for (let attempt = 0; ; ++attempt) {
      try {
        return await this.#fetch(url, {
          method,
          headers,
          body: init.body
        });
      } catch (err) {
        const cause = err.cause?.code ?? null;
        // A refused connection carried no request and a read changes nothing; any other write may have applied.
        const repeatable = method === 'GET' || cause === 'ECONNREFUSED';
        if (!repeatable || attempt >= this.#retryDelays.length)
          throw networkError(err, cause, method, url, attempt + 1);
        await sleep(this.#retryDelays[attempt]);
      }
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
    const known = STATUS_CODES[status];
    if (known) return known;
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
