// Migration orchestrator: source-tree → target-tree transformer + DB seeder.
//
// Phase 1 of the migration runbook. Two passes over the source:
//   1. Collect every raw tag value seen across all frontmatter blocks.
//   2. Build the canonical/alias maps from that corpus.
// Then a single pass that:
//   - reads each source file
//   - applies status / type / tag remap (and frontmatter backfill where empty)
//   - writes the transformed file to the target tree (preserving relative path)
// And finally:
//   - seeds tags_taxonomy + tag_aliases in the DB (so a subsequent importVault
//     against the target tree can attach per-record tags later without
//     hitting the CHECK trigger).
//
// Embeddings, edges, and per-record tag insertion are handled by the standard
// importer pipeline once it runs against the target tree.

import {mkdirSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {parseFrontmatter} from '../markdown/frontmatter.ts';
import {walkMarkdown} from '../importer/walk.ts';
import {atomizeVault, type AtomizationOptions, type AtomizeSummary} from './atomize.ts';
import {seedTagsTaxonomy} from './seed-taxonomy.ts';
import {transformFile} from './transform.ts';
import {buildTagMap, type TagMap} from './tags.ts';

export interface MigrationOptions {
  source: string;
  target: string;
  db: DatabaseSync;
  /** Default: today as YYYY-MM-DD. Overridable for deterministic tests. */
  isoDate?: string;
  /** Skip the atomization pass on the migrated tree. Default false. */
  skipAtomize?: boolean;
  /** Override atomization thresholds. */
  atomization?: AtomizationOptions;
}

export interface MigrationSummary {
  total: number;
  /** Files where frontmatter was bootstrapped from empty. */
  backfilled: number;
  /** Files where at least one tag was rewritten. */
  filesWithTagRewrites: number;
  /** Sum of tag-rewrite events across files. */
  tagRewrites: number;
  canonicalTagCount: number;
  pluralCollapses: Array<{plural: string; singular: string}>;
  /** Atomization pass result; null when skipped. */
  atomization: AtomizeSummary | null;
  durationMs: number;
}

const collectRawTags = (source: string): Set<string> => {
  const out = new Set<string>();
  for (const file of walkMarkdown(source)) {
    const text = readFileSync(file.absolutePath, 'utf8');
    const {data} = parseFrontmatter(text);
    const tags = data['tags'];
    if (Array.isArray(tags)) {
      for (const t of tags) if (typeof t === 'string') out.add(t);
    }
  }
  return out;
};

export const migrateVault = (opts: MigrationOptions): MigrationSummary => {
  const start = performance.now();
  const isoDate = opts.isoDate ?? new Date().toISOString().slice(0, 10);

  if (!existsSync(opts.source)) {
    throw new Error(`source does not exist: ${opts.source}`);
  }
  mkdirSync(opts.target, {recursive: true});

  const rawTags = collectRawTags(opts.source);
  const tagMap: TagMap = buildTagMap(rawTags);

  let total = 0;
  let backfilled = 0;
  let filesWithTagRewrites = 0;
  let tagRewrites = 0;

  for (const file of walkMarkdown(opts.source)) {
    total++;
    const text = readFileSync(file.absolutePath, 'utf8');
    const result = transformFile(text, {relativePath: file.relativePath, tagMap, isoDate});

    const targetAbs = join(opts.target, file.relativePath);
    mkdirSync(dirname(targetAbs), {recursive: true});
    writeFileSync(targetAbs, result.output, 'utf8');

    if (result.backfilled) backfilled++;
    if (result.rewrites.length > 0) {
      filesWithTagRewrites++;
      tagRewrites += result.rewrites.length;
    }
  }

  seedTagsTaxonomy(opts.db, tagMap, isoDate);

  const atomization = opts.skipAtomize ? null : atomizeVault(opts.target, opts.atomization);

  return {
    total,
    backfilled,
    filesWithTagRewrites,
    tagRewrites,
    canonicalTagCount: tagMap.canonical.size,
    pluralCollapses: tagMap.pluralCollapses,
    atomization,
    durationMs: Math.round(performance.now() - start)
  };
};
