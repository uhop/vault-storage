// Raw-inbox scanner. The vault's `raw/` folder is a quick-capture
// inbox: notes are dropped in, optionally edited across sessions, and
// then marked `ready: true` in frontmatter when ripe for `/vault
// ingest`. Drafts (no `ready: true`) stay until the user flips the flag.
//
// This module reads `raw/` from disk, parses each note's frontmatter,
// and classifies it as `ready` or `draft`. Used by GET
// /maintenance/raw-inbox to drive the dashboard's ingest reminder.

import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {parseFrontmatter} from '../markdown/frontmatter.ts';

export interface RawInboxItem {
  path: string;
  title: string | null;
  updated: string | null;
}

export interface RawInboxSummary {
  ready: RawInboxItem[];
  drafts: RawInboxItem[];
}

const META_FILES: ReadonlySet<string> = new Set(['_about.md']);

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const isReadyFlag = (v: unknown): boolean => v === true;

/**
 * Scan `<vaultDataPath>/raw/` for top-level `.md` files (excluding meta
 * files like `_about.md` and the `archive/` subfolder), parse each
 * file's frontmatter, and split into ready vs draft buckets.
 *
 * Returns empty arrays when `raw/` doesn't exist. Files that fail to
 * read or parse are silently skipped — the inbox is human-edited, so
 * malformed YAML in a draft is a transient state, not an error.
 */
export const scanRawInbox = (vaultDataPath: string): RawInboxSummary => {
  const rawDir = join(vaultDataPath, 'raw');
  let entries: string[];
  try {
    entries = readdirSync(rawDir);
  } catch {
    return {ready: [], drafts: []};
  }

  const ready: RawInboxItem[] = [];
  const drafts: RawInboxItem[] = [];

  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    if (META_FILES.has(name)) continue;
    const abs = join(rawDir, name);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let source: string;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    let data: Record<string, unknown>;
    try {
      data = parseFrontmatter(source).data;
    } catch {
      // Malformed YAML in a quick-capture draft is a transient state.
      // Treat as a draft with no metadata so the user still sees it.
      data = {};
    }
    const item: RawInboxItem = {
      path: `raw/${name}`,
      title: asString(data['title']),
      updated: asString(data['updated'])
    };
    if (isReadyFlag(data['ready'])) ready.push(item);
    else drafts.push(item);
  }

  ready.sort((a, b) => a.path.localeCompare(b.path));
  drafts.sort((a, b) => a.path.localeCompare(b.path));
  return {ready, drafts};
};
