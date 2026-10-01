// The nearest existing tags for a text or a proposed name, shared by
// `POST /tags/nearest` and the write path's unknown-tag answer (D82).

import type {DatabaseSync, StatementSync} from 'node:sqlite';
import {TagVecRepository} from '../db/tag-vec-repo.ts';
import {embedTagsPending} from '../embeddings/embed-tags.ts';
import type {Embedder} from '../embeddings/types.ts';
import {prepared} from '../db/prepared.ts';

export type Matched = 'exact' | 'alias' | 'name' | 'embedding';

export interface NearestQuery {
  query: string;
  kind: 'text' | 'tag';
}

export interface NearestItem {
  tag: string;
  description: string | null;
  origin: string;
  record_count: number;
  score: number | null;
  matched: Matched[];
}

export interface NearestResult {
  query: string;
  kind: 'text' | 'tag';
  exact: {tag: string; requested?: string} | null;
  items: NearestItem[];
}

export interface NearestAnswer {
  queries: NearestResult[];
  tag_vecs: {embedded: number; up_to_date: number; total: number};
}

export const NEAREST_K_DEFAULT = 12;
export const NEAREST_K_MAX = 50;
export const NEAREST_QUERIES_MAX = 50;
const NAME_WORD_MIN = 3;

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

/** A proposed name in taxonomy form: lowercase, words joined by hyphens. */
export const tagForm = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');

/** The same scale as /similar: 1 for an identical vector, from the L2 distance of unit vectors. */
const scoreOfDistance = (distance: number): number => Number((1 - distance / 2).toFixed(4));

const distanceBetween = (a: Float32Array, b: Float32Array): number => {
  let sum = 0;
  for (let i = 0; i < a.length; ++i) {
    const d = a[i]! - (b[i] ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
};

interface Candidate {
  score: number | null;
  matched: Set<Matched>;
}

interface DetailRow {
  tag: string;
  description: string | null;
  origin: string;
  record_count: number;
}

/**
 * Every query is scored against the embedding of each tag's name and
 * description; a proposed name is also matched exactly (canonical or alias,
 * ranked first) and by its words against tag names and aliases, those hits
 * scored from their stored vector. The tag vectors are refreshed on the way
 * in, so a tag added or re-described since the last call is embedded here.
 */
export class TagNearest {
  readonly #db: DatabaseSync;
  readonly #embedder: Embedder;
  readonly #canonicalOf: StatementSync;
  readonly #aliasOf: StatementSync;
  readonly #tagsLike: StatementSync;
  readonly #aliasesLike: StatementSync;
  readonly #detail: StatementSync;
  readonly #vecs: TagVecRepository;

  constructor(db: DatabaseSync, embedder: Embedder) {
    this.#db = db;
    this.#embedder = embedder;
    this.#canonicalOf = prepared(db, 'SELECT tag FROM tags_taxonomy WHERE tag = ?');
    this.#aliasOf = prepared(db, 'SELECT canonical FROM tag_aliases WHERE alias = ?');
    this.#tagsLike = prepared(
      db,
      `SELECT tag FROM tags_taxonomy WHERE tag LIKE ? ESCAPE '\\' ORDER BY tag LIMIT ${NEAREST_K_MAX}`
    );
    this.#aliasesLike = prepared(
      db,
      `SELECT canonical FROM tag_aliases WHERE alias LIKE ? ESCAPE '\\' ORDER BY alias LIMIT ${NEAREST_K_MAX}`
    );
    this.#detail = prepared(
      db,
      `SELECT t.tag, t.description, t.origin,
              (SELECT COUNT(*) FROM tags WHERE tags.tag = t.tag) AS record_count
         FROM tags_taxonomy t WHERE t.tag = ?`
    );
    this.#vecs = new TagVecRepository(db);
  }

  async query(queries: NearestQuery[], k: number): Promise<NearestAnswer> {
    const tagVecs = await embedTagsPending(this.#db, this.#embedder);
    const results: NearestResult[] = [];
    for (const {query, kind} of queries) results.push(await this.#one(query, kind, k));
    return {
      queries: results,
      tag_vecs: {embedded: tagVecs.embedded, up_to_date: tagVecs.upToDate, total: tagVecs.total}
    };
  }

  #nameHits(needle: string): {tag: string; how: Matched}[] {
    const words = new Set([needle, ...needle.split('-').filter(w => w.length >= NAME_WORD_MIN)]);
    const hits: {tag: string; how: Matched}[] = [];
    for (const word of words) {
      const pattern = `%${likeEscape(word)}%`;
      for (const r of this.#tagsLike.all(pattern) as unknown[] as {tag: string}[]) {
        hits.push({tag: r.tag, how: 'name'});
      }
      for (const r of this.#aliasesLike.all(pattern) as unknown[] as {canonical: string}[]) {
        hits.push({tag: r.canonical, how: 'alias'});
      }
    }
    return hits;
  }

  async #one(query: string, kind: 'text' | 'tag', k: number): Promise<NearestResult> {
    const found = new Map<string, Candidate>();
    const add = (tag: string, how: Matched, score: number | null): void => {
      let entry = found.get(tag);
      if (!entry) {
        entry = {score: null, matched: new Set()};
        found.set(tag, entry);
      }
      entry.matched.add(how);
      if (score !== null) entry.score = score;
    };

    let exact: NearestResult['exact'] = null;
    let embedInput = query;
    if (kind === 'tag') {
      const needle = tagForm(query);
      embedInput = needle.replace(/-+/g, ' ');
      const canonical = this.#canonicalOf.get(needle) as {tag: string} | undefined;
      const alias = this.#aliasOf.get(needle) as {canonical: string} | undefined;
      if (canonical) {
        exact = {tag: canonical.tag};
        add(canonical.tag, 'exact', null);
      } else if (alias) {
        exact = {tag: alias.canonical, requested: needle};
        add(alias.canonical, 'exact', null);
      }
      for (const hit of this.#nameHits(needle)) add(hit.tag, hit.how, null);
    }

    const qvec = await this.#embedder.embedQuery(embedInput);
    for (const hit of this.#vecs.nearest(qvec, k)) {
      add(hit.tag, 'embedding', scoreOfDistance(hit.distance));
    }
    for (const [tag, entry] of found) {
      if (entry.score !== null) continue;
      const stored = this.#vecs.get(tag);
      if (stored) entry.score = scoreOfDistance(distanceBetween(qvec, stored));
    }

    // An exact hit is the answer whatever its vector says; then best score first.
    const ranked = [...found.entries()]
      .sort(([tagA, a], [tagB, b]) => {
        const exactA = a.matched.has('exact');
        if (exactA !== b.matched.has('exact')) return exactA ? -1 : 1;
        if (a.score === b.score) return tagA < tagB ? -1 : tagA > tagB ? 1 : 0;
        if (a.score === null) return 1;
        if (b.score === null) return -1;
        return b.score - a.score;
      })
      .slice(0, k);

    const items: NearestItem[] = [];
    for (const [tag, entry] of ranked) {
      const row = this.#detail.get(tag) as DetailRow | undefined;
      if (!row) continue;
      items.push({
        tag: row.tag,
        description: row.description,
        origin: row.origin,
        record_count: row.record_count,
        score: entry.score,
        matched: [...entry.matched]
      });
    }
    return {query, kind, exact, items};
  }
}
