// Per-file transform: applies status / type / tag canonicalization to one
// markdown file's frontmatter and (where missing) backfills the minimum.
//
// Returns a transformed (frontmatter, body) pair for the migration writer to
// emit to the target tree. Pure: no I/O, no DB.

import {parseFrontmatter, serializeFrontmatter} from '../markdown/frontmatter.ts';
import {typeFromPath} from '../importer/type-from-path.ts';
import type {RecordType} from '../records/types.ts';
import {backfillFrontmatter} from './frontmatter-backfill.ts';
import {remapStatus} from './status.ts';
import {canonicalizeTag, type TagMap} from './tags.ts';
import {remapType} from './type.ts';

export interface TransformOptions {
  /** Vault-relative path (forward-slashed). */
  relativePath: string;
  /** Pre-built canonical/alias map covering every tag observed across the source. */
  tagMap: TagMap;
  /** Today's date as ISO `YYYY-MM-DD`; used for created/updated when absent. */
  isoDate: string;
}

export interface TransformResult {
  /** The full file content to write (frontmatter + body). */
  output: string;
  /** Whether frontmatter was bootstrapped from scratch. */
  backfilled: boolean;
  /** Tags that were rewritten (raw → canonical). */
  rewrites: Array<{from: string; to: string}>;
  /** Final canonical tags written to frontmatter. */
  finalTags: string[];
}

const asTags = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
};

export const transformFile = (source: string, opts: TransformOptions): TransformResult => {
  const {relativePath, tagMap, isoDate} = opts;
  const parsed = parseFrontmatter(source);
  const inferred: RecordType = typeFromPath(relativePath);

  let data: Record<string, unknown> = {...parsed.data};
  let backfilled = false;

  // Backfill if frontmatter is empty (no parseable block at the top).
  if (Object.keys(data).length === 0) {
    const fm = backfillFrontmatter(relativePath, parsed.body, inferred, isoDate);
    data = {
      title: fm.title,
      tags: fm.tags,
      status: fm.status,
      type: fm.type,
      created: fm.created,
      updated: fm.updated
    };
    backfilled = true;
  } else {
    // Type: prefer explicit (with legacy remap); else folder default.
    const remappedType = remapType(data['type']);
    data['type'] = remappedType ?? inferred;
    // Status: always normalize via remap (defaults to active).
    data['status'] = remapStatus(data['status']);
  }

  // Tag canonicalization runs in both branches (a backfilled file has no tags
  // yet, but the call is harmless). Drop empty results, dedupe.
  const rawTags = asTags(data['tags']);
  const rewrites: Array<{from: string; to: string}> = [];
  const finalSet = new Set<string>();
  for (const raw of rawTags) {
    const canon = canonicalizeTag(raw, tagMap);
    if (!canon) continue;
    finalSet.add(canon);
    if (canon !== raw) rewrites.push({from: raw, to: canon});
  }
  const finalTags = [...finalSet];
  data['tags'] = finalTags;

  const output = serializeFrontmatter({data, body: parsed.body});
  return {output, backfilled, rewrites, finalTags};
};
