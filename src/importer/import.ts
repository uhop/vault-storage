import type {DatabaseSync} from 'node:sqlite';
import {RecordsRepository} from '../records/repository.ts';
import {buildEdges, type EdgeBuildSummary} from './build-edges.ts';
import {importFile} from './import-file.ts';
import {walkMarkdown} from './walk.ts';

export interface ImportSummary {
  inserted: number;
  updated: number;
  unchanged: number;
  total: number;
  durationMs: number;
  edges: EdgeBuildSummary;
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
  const start = performance.now();
  const now = new Date().toISOString();

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let total = 0;

  db.exec('BEGIN');
  try {
    for (const file of walkMarkdown(vaultRoot)) {
      const result = importFile(records, file.relativePath, file.absolutePath, now);
      total++;
      if (result.action === 'inserted') inserted++;
      else if (result.action === 'updated') updated++;
      else unchanged++;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const edges = buildEdges(db, {vaultRoot, now});

  return {
    inserted,
    updated,
    unchanged,
    total,
    durationMs: Math.round(performance.now() - start),
    edges
  };
};
