import type {IncomingMessage, ServerResponse} from 'node:http';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Decoded path (no querystring). */
  path: string;
  /** Pre-parsed querystring as a plain object. Repeated keys are joined by `,`. */
  query: Record<string, string>;
  /** Path parameters extracted from the route pattern. */
  params: Record<string, string>;
}

export type Handler = (ctx: RequestContext) => Promise<void> | void;

interface CompiledRoute {
  method: string;
  regex: RegExp;
  paramNames: string[];
  handler: Handler;
}

const PARAM = /\{([^/{}]+)\}/g;

const compileRoute = (method: string, pattern: string, handler: Handler): CompiledRoute => {
  const paramNames: string[] = [];
  // Path-shaped {path} captures slashes; opaque {id}-style does not.
  const regexSrc = pattern.replace(PARAM, (_match, name: string) => {
    paramNames.push(name);
    return name === 'path' ? '(.+)' : '([^/]+)';
  });
  return {
    method,
    regex: new RegExp(`^${regexSrc}$`),
    paramNames,
    handler
  };
};

export class Router {
  readonly #routes: CompiledRoute[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.#routes.push(compileRoute(method.toUpperCase(), pattern, handler));
    return this;
  }

  get(pattern: string, handler: Handler): this {
    return this.add('GET', pattern, handler);
  }

  put(pattern: string, handler: Handler): this {
    return this.add('PUT', pattern, handler);
  }

  post(pattern: string, handler: Handler): this {
    return this.add('POST', pattern, handler);
  }

  patch(pattern: string, handler: Handler): this {
    return this.add('PATCH', pattern, handler);
  }

  delete(pattern: string, handler: Handler): this {
    return this.add('DELETE', pattern, handler);
  }

  /** Find the matching route, or null. Method mismatch on a path match returns 'method-not-allowed'. */
  match(
    method: string,
    path: string
  ): {handler: Handler; params: Record<string, string>} | 'method-not-allowed' | null {
    let pathMatched = false;
    for (const route of this.#routes) {
      const result = route.regex.exec(path);
      if (!result) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        const raw = result[i + 1];
        params[name] = raw === undefined ? '' : decodeURIComponent(raw);
      });
      return {handler: route.handler, params};
    }
    return pathMatched ? 'method-not-allowed' : null;
  }
}
