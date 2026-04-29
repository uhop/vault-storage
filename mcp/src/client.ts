// REST client for the vault-storage server. Thin wrapper that prepends the
// configured base URL and `Authorization: Bearer <token>` header to every
// request, normalises errors into a typed shape MCP tool handlers can render
// directly to the agent.

export interface ClientConfig {
  /** Base URL — e.g. `http://croc.lan:8123`. No trailing slash required. */
  apiUrl: string;
  /** Bearer token — sent on every request. */
  apiToken: string;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
}

export class VaultClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, code: string, status: number, details: unknown = null) {
    super(message);
    this.name = 'VaultClientError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

interface ApiErrorBody {
  error?: string;
  code?: string;
  details?: unknown;
}

const stripTrailingSlash = (s: string): string => (s.endsWith('/') ? s.slice(0, -1) : s);

export class VaultClient {
  readonly #apiUrl: string;
  readonly #apiToken: string;
  readonly #fetch: typeof fetch;

  constructor(config: ClientConfig) {
    if (!config.apiUrl) throw new Error('VaultClient: apiUrl is required');
    if (!config.apiToken) throw new Error('VaultClient: apiToken is required');
    this.#apiUrl = stripTrailingSlash(config.apiUrl);
    this.#apiToken = config.apiToken;
    this.#fetch = config.fetchImpl ?? fetch;
  }

  /** Build a full URL from a path + optional query parameters. */
  url(path: string, query: Record<string, string | number | boolean | undefined> = {}): string {
    const normalisedPath = path.startsWith('/') ? path : `/${path}`;
    const u = new URL(`${this.#apiUrl}${normalisedPath}`);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  async getJson<T = unknown>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {}
  ): Promise<T> {
    const res = await this.#request('GET', this.url(path, query));
    return this.#parseJson<T>(res);
  }

  async getText(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {}
  ): Promise<string> {
    const res = await this.#request('GET', this.url(path, query));
    if (!res.ok) await this.#throwFromResponse(res);
    return res.text();
  }

  async putText(
    path: string,
    body: string,
    contentType = 'text/markdown'
  ): Promise<void> {
    const res = await this.#request('PUT', this.url(path), {body, contentType});
    if (res.status === 204) return;
    if (!res.ok) await this.#throwFromResponse(res);
  }

  async deletePath(path: string): Promise<void> {
    const res = await this.#request('DELETE', this.url(path));
    if (res.status === 204) return;
    if (!res.ok) await this.#throwFromResponse(res);
  }

  async postJson<T = unknown>(
    path: string,
    body?: unknown,
    query: Record<string, string | number | boolean | undefined> = {}
  ): Promise<T> {
    const init: {body?: string; contentType?: string} = {};
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.contentType = 'application/json';
    }
    const res = await this.#request('POST', this.url(path, query), init);
    return this.#parseJson<T>(res);
  }

  async #request(
    method: string,
    url: string,
    init: {body?: string; contentType?: string} = {}
  ): Promise<Response> {
    const headers: Record<string, string> = {
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
      throw new VaultClientError(
        `network error: ${(err as Error).message}`,
        'network',
        0,
        {url, method}
      );
    }
  }

  async #parseJson<T>(res: Response): Promise<T> {
    if (!res.ok) await this.#throwFromResponse(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new VaultClientError(
        `invalid JSON from server: ${(err as Error).message}`,
        'invalid_response',
        res.status,
        {raw: text.slice(0, 500)}
      );
    }
  }

  async #throwFromResponse(res: Response): Promise<never> {
    const text = await res.text().catch(() => '');
    let body: ApiErrorBody | null = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as ApiErrorBody;
      } catch {
        // Non-JSON error body — keep the raw text in details.
      }
    }
    const code = body?.code ?? this.#defaultCode(res.status);
    const message = body?.error ?? `HTTP ${res.status}`;
    throw new VaultClientError(message, code, res.status, body?.details ?? text);
  }

  #defaultCode(status: number): string {
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
export const clientFromEnv = (): VaultClient =>
  new VaultClient({
    apiUrl: required('VAULT_API_URL'),
    apiToken: required('VAULT_API_TOKEN')
  });

const required = (name: string): string => {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(
      `${name} is required (set it in your MCP server configuration's env block)`
    );
  }
  return v;
};
