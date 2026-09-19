import type {DatabaseSync} from 'node:sqlite';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {RecordsRepository} from '../records/repository.ts';
import {buildEdges, buildEdgesAsync, type EdgeBuildSummary} from './build-edges.ts';
import {importFile} from './import-file.ts';
import {fullImportOptions} from './import-options.ts';
import {walkMarkdown, type MarkdownFile} from './walk.ts';

export interface ImportSummary {
  inserted: number;
  updated: number;
  unchanged: number;
  /** Files where parse / validation threw — body and path printed to stderr. */
  skipped: number;
  total: number;
  durationMs: number;
  edges: EdgeBuildSummary;
}

type ImportCounts = Omit<ImportSummary, 'durationMs' | 'edges'>;

/** Files per transaction, and per uninterrupted turn of the event loop in {@link importVaultAsync}. */
export const IMPORT_BATCH_FILES = 50;

/**
 * Import every .md file under `vaultRoot`, one transaction per batch, pausing
 * after each batch. Each file is read and upserted in one synchronous turn, so
 * no write can land between the two.
 */
function* importBatches(
  db: DatabaseSync,
  vaultRoot: string,
  now: string,
  counts: ImportCounts
): Generator<void, void, void> {
  const records = new RecordsRepository(db);
  const options = fullImportOptions(db);

  const flush = (batch: readonly MarkdownFile[]): void => {
    db.exec('BEGIN');
    try {
      for (const file of batch) {
        ++counts.total;
        try {
          const result = importFile(records, file.relativePath, file.absolutePath, now, options);
          ++counts[result.action];
        } catch (err) {
          ++counts.skipped;
          const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
          process.stderr.write(`skip ${file.relativePath}: ${msg}\n`);
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  let batch: MarkdownFile[] = [];
  for (const file of walkMarkdown(vaultRoot)) {
    batch.push(file);
    if (batch.length < IMPORT_BATCH_FILES) continue;
    flush(batch);
    batch = [];
    yield;
  }
  if (batch.length) flush(batch);
}

const emptyCounts = (): ImportCounts => ({
  inserted: 0,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  total: 0
});

/**
 * Walk `vaultRoot`, parse every .md file, and upsert into records.
 *
 * v1 limitation: each file becomes one record. Atomization (one record per
 * top-level section, per design constraint C13) is a separate later pass that
 * runs against the imported records, not at import time.
 */
export const importVault = (db: DatabaseSync, vaultRoot: string): ImportSummary => {
  const start = performance.now();
  const now = new Date().toISOString();
  const counts = emptyCounts();
  const steps = importBatches(db, vaultRoot, now, counts);
  while (!steps.next().done);
  const edges = buildEdges(db, {vaultRoot, now});
  return {...counts, durationMs: Math.round(performance.now() - start), edges};
};

/**
 * {@link importVault} for the server: yields to the event loop between batches,
 * the edge rebuild included ({@link buildEdgesAsync}).
 */
export const importVaultAsync = async (
  db: DatabaseSync,
  vaultRoot: string
): Promise<ImportSummary> => {
  const start = performance.now();
  const now = new Date().toISOString();
  const counts = emptyCounts();
  const steps = importBatches(db, vaultRoot, now, counts);
  while (!steps.next().done) await nextTurn();
  const edges = await buildEdgesAsync(db, {vaultRoot, now});
  return {...counts, durationMs: Math.round(performance.now() - start), edges};
};
