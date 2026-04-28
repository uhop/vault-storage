import type {DatabaseSync} from 'node:sqlite';
import {RecordsRepository} from '../records/repository.ts';
import {importFile} from './import-file.ts';
import {walkMarkdown} from './walk.ts';

export interface ImportSummary {
  inserted: number;
  updated: number;
  unchanged: number;
  total: number;
  durationMs: number;
}

/**
 * Walk `vaultRoot`, parse every .md file, and upsert into records.
 *
 * v1 limitation: each file becomes one record. Atomization (one record per
 * top-level section, per design constraint C13) is a separate later pass that
 * runs against the imported records, not at import time.
 */
export const importVault = (db: DatabaseSync, vaultRoot: string): ImportSummary => {
  const records = new RecordsRepository(db);
  const summary: ImportSummary = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    total: 0,
    durationMs: 0
  };
  const start = performance.now();
  const now = new Date().toISOString();

  db.exec('BEGIN');
  try {
    for (const file of walkMarkdown(vaultRoot)) {
      const result = importFile(records, file.relativePath, file.absolutePath, now);
      summary[result.action]++;
      summary.total++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  summary.durationMs = Math.round(performance.now() - start);
  return summary;
};
