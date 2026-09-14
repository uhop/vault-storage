// The server's initial reindex. The database persists across restarts, so a
// restart imports only what changed since `last_indexed_commit`, plus the
// uncommitted working tree. A full import runs when the stored index cannot be
// trusted: no anchor, a migration ran, or the code that derives records from
// files changed since the last full import.

import type {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {dirname, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {getMetaValue, setMetaValue} from '../db/meta.ts';
import {contentHash} from '../util/hash.ts';
import {
  clearLastIndexedCommit,
  getLastIndexedCommit,
  incrementalReindex,
  type IncrementalReindexSummary
} from './incremental-reindex.ts';

export const IMPORTER_FINGERPRINT_KEY = 'importer_fingerprint';

export type FullReindexReason = 'no-anchor' | 'migrations' | 'importer-changed';

export interface StartupReindexSummary extends IncrementalReindexSummary {
  /** Why a full import was forced; null when the reindex ran incrementally. */
  reason: FullReindexReason | null;
}

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IMPORTER_ENTRIES = ['importer/import.ts', 'maintenance/incremental-reindex.ts'];
const RELATIVE_IMPORT = /\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]/g;

/**
 * SHA-256 over the source of every module the importer reaches through
 * relative imports: a change to any of them can change what a file derives.
 */
export const importerFingerprint = async (
  entries: readonly string[] = IMPORTER_ENTRIES.map(e => resolve(SRC_ROOT, e))
): Promise<string> => {
  const sources = new Map<string, string>();
  const pending = [...entries];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (sources.has(file)) continue;
    const text = await readFile(file, 'utf8');
    sources.set(file, text);
    for (const [, specifier] of text.matchAll(RELATIVE_IMPORT)) {
      pending.push(resolve(dirname(file), specifier as string));
    }
  }
  const parts = [...sources].map(([file, text]) => `${relative(SRC_ROOT, file)}\t${text}`).sort();
  return contentHash(parts.join('\t'));
};

export const startupReindex = async (
  db: DatabaseSync,
  vaultDataPath: string,
  opts: {migrationsApplied: readonly string[]; fingerprint?: string}
): Promise<StartupReindexSummary> => {
  const fingerprint = opts.fingerprint ?? (await importerFingerprint());
  const reason: FullReindexReason | null =
    getLastIndexedCommit(db) === null
      ? 'no-anchor'
      : opts.migrationsApplied.length > 0
        ? 'migrations'
        : getMetaValue(db, IMPORTER_FINGERPRINT_KEY) !== fingerprint
          ? 'importer-changed'
          : null;
  // Clearing first makes a crash mid-import retry the full import next start.
  if (reason !== null) clearLastIndexedCommit(db);
  const summary = await incrementalReindex(db, vaultDataPath, {workingTree: true});
  if (reason !== null) setMetaValue(db, IMPORTER_FINGERPRINT_KEY, fingerprint);
  return {...summary, reason};
};
