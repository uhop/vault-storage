// The write path's unknown-tag answer: which of a request's `tags:` the
// taxonomy does not know, after the importer's own normalization and alias
// map, each with the nearest existing tags. Soft by default (the write lands,
// the importer files its `new_tag`, the answer names the candidates); with
// `strict_tags` the write is refused before anything is written or filed.

import type {ServerResponse} from 'node:http';
import type {DatabaseSync} from 'node:sqlite';
import type {Embedder} from '../embeddings/types.ts';
import {TagsImporter} from '../importer/import-tags.ts';
import {parseFrontmatter} from '../markdown/frontmatter.ts';
import {sendError, sendJson, sendNoContent} from './responses.ts';
import {TagNearest, type NearestItem} from './tag-nearest.ts';
import type {ParsedWriteRequest} from './writer.ts';

export interface UnknownTagRef {
  /** As the request wrote it. */
  tag: string;
  /** The form the importer would store: normalized, alias-resolved. */
  resolved: string;
}

export interface UnknownTag extends UnknownTagRef {
  nearest: NearestItem[];
}

export const UNKNOWN_TAG_CANDIDATES = 5;

export class TagChecker {
  readonly #tags: TagsImporter;
  readonly #nearest: TagNearest;

  constructor(db: DatabaseSync, embedder: Embedder) {
    this.#tags = new TagsImporter(db);
    this.#nearest = new TagNearest(db, embedder);
  }

  /** The request's tags the taxonomy does not know, one entry per resolved form. */
  unknownIn(tags: unknown): UnknownTagRef[] {
    if (!Array.isArray(tags)) return [];
    const seen = new Set<string>();
    const unknown: UnknownTagRef[] = [];
    for (const raw of tags) {
      if (typeof raw !== 'string') continue;
      const resolved = this.#tags.resolveTag(raw);
      if (resolved === null || seen.has(resolved) || this.#tags.isKnown(resolved)) continue;
      seen.add(resolved);
      unknown.push({tag: raw, resolved});
    }
    return unknown;
  }

  async withNearest(unknown: UnknownTagRef[]): Promise<UnknownTag[]> {
    if (unknown.length === 0) return [];
    const {queries} = await this.#nearest.query(
      unknown.map(u => ({query: u.resolved, kind: 'tag'})),
      UNKNOWN_TAG_CANDIDATES
    );
    return unknown.map((u, i) => ({...u, nearest: queries[i]?.items ?? []}));
  }
}

/**
 * The `tags:` a write request carries; undefined when it carries none. A
 * markdown block the writer is about to reject parses to undefined here, so
 * the writer's own 400 is the one the caller sees.
 */
export const requestTags = (parsed: ParsedWriteRequest): unknown => {
  if (parsed.kind === 'json') return parsed.frontmatter['tags'];
  try {
    return parseFrontmatter(parsed.markdown).data['tags'];
  } catch {
    return undefined;
  }
};

/** 409 `unknown_tags` with the candidates; nothing has been written. */
export const refuseUnknownTags = async (
  res: ServerResponse,
  checker: TagChecker,
  unknown: UnknownTagRef[]
): Promise<void> => {
  const names = unknown.map(u => u.resolved).join(', ');
  sendError(
    res,
    409,
    'unknown_tags',
    `${unknown.length} tag(s) not in the taxonomy: ${names}. Pick from the nearest existing tags in details.unknown, or create the tag first with POST /tags/taxonomy`,
    {unknown: await checker.withNearest(unknown)}
  );
};

/** 204 with the ETag when every tag was known; 200 `{etag, unknown_tags}` otherwise. */
export const respondWritten = async (
  res: ServerResponse,
  checker: TagChecker,
  etag: string,
  unknown: UnknownTagRef[]
): Promise<void> => {
  if (unknown.length === 0) {
    sendNoContent(res, {ETag: `"${etag}"`});
    return;
  }
  sendJson(res, 200, {etag, unknown_tags: await checker.withNearest(unknown)}, {ETag: `"${etag}"`});
};
