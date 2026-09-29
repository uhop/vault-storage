// The write path's typed-edge answer: which of a request's `edges:` targets
// resolve to no note. Soft by default (the write lands, the answer names
// them) and a 409 with `strict_edges`, mirroring `strict_tags` in
// tag-check.ts. The map's types are the writer's to check: a value outside
// the closed vocabulary is its 400 `invalid_enum_value`.

import type {ServerResponse} from 'node:http';
import {parseFrontmatter} from '../markdown/frontmatter.ts';
import type {ResolverCache} from './resolver-cache.ts';
import {sendError} from './responses.ts';
import type {ParsedWriteRequest} from './writer.ts';

export interface UnresolvedEdge {
  /** The wikilink target as the request wrote it. */
  target: string;
  type: string;
}

/** The `edges:` a write request carries; undefined when it carries none or the block does not parse. */
export const requestEdges = (parsed: ParsedWriteRequest): unknown => {
  if (parsed.kind === 'json') return parsed.frontmatter['edges'];
  try {
    return parseFrontmatter(parsed.markdown).data['edges'];
  } catch {
    return undefined;
  }
};

export class EdgeChecker {
  readonly #resolver: ResolverCache;

  constructor(resolver: ResolverCache) {
    this.#resolver = resolver;
  }

  /** The entries whose target resolves to no note; a value that is not a string is the writer's to refuse. */
  unresolvedIn(edges: unknown): UnresolvedEdge[] {
    if (!edges || typeof edges !== 'object' || Array.isArray(edges)) return [];
    const {resolver} = this.#resolver.get();
    const out: UnresolvedEdge[] = [];
    for (const [target, type] of Object.entries(edges as Record<string, unknown>)) {
      if (typeof type !== 'string') continue;
      if (resolver.resolve(target) === null) out.push({target, type});
    }
    return out;
  }
}

/** 409 `unresolved_edges`; nothing has been written. */
export const refuseUnresolvedEdges = (res: ServerResponse, unresolved: UnresolvedEdge[]): void => {
  const names = unresolved.map(u => u.target).join(', ');
  sendError(
    res,
    409,
    'unresolved_edges',
    `${unresolved.length} edges target(s) resolve to no note: ${names}. Fix the wikilink targets in details.unresolved, or write without strict_edges`,
    {unresolved}
  );
};
