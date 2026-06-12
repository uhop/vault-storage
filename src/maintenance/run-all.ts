// The bundled maintenance pass: every find-* scan in one call. Shared by
// `POST /maintenance/run-all` (manual trigger — always wins, per C8.1) and
// the scan scheduler's automatic ticks. Completing a pass records the
// `scan_last_pass_*` marker, so a manual run pushes back the next automatic
// one — both paths count as "the vault has been scanned".

import type {DatabaseSync} from 'node:sqlite';
import {getContentGeneration, setMetaValue} from '../db/meta.ts';
import {findCompactionCandidates} from './find-compaction-candidates.ts';
import {findDuplicates} from './find-duplicates.ts';
import {findRetentionCandidates} from './find-retention-candidates.ts';
import {findUpgradeSignals} from './find-upgrade-signals.ts';

/** Content generation as of the start of the last completed pass. */
export const SCAN_LAST_PASS_GENERATION_KEY = 'scan_last_pass_generation';
/** ISO instant the last pass completed. */
export const SCAN_LAST_PASS_AT_KEY = 'scan_last_pass_at';

export interface RunAllScansSummary {
  duplicates: ReturnType<typeof findDuplicates>;
  compaction: ReturnType<typeof findCompactionCandidates>;
  retention: ReturnType<typeof findRetentionCandidates>;
  upgrade: ReturnType<typeof findUpgradeSignals>;
  durationMs: number;
}

/**
 * Record that a maintenance pass just completed. Exported for tests that
 * inject a fake scan runner into the scheduler.
 */
export const recordScanPass = (db: DatabaseSync, generation: number, atIso: string): void => {
  setMetaValue(db, SCAN_LAST_PASS_GENERATION_KEY, String(generation));
  setMetaValue(db, SCAN_LAST_PASS_AT_KEY, atIso);
};

export const runAllScans = (db: DatabaseSync): RunAllScansSummary => {
  const start = Date.now();
  // Capture the generation before scanning: the scans are synchronous, so
  // nothing can change mid-pass, but "before" stays correct if that ever
  // loosens — a write racing the pass re-arms the next tick.
  const generation = getContentGeneration(db);
  const duplicates = findDuplicates(db, {
    maxDistance: 0.1,
    perRecord: 10,
    minBodyLength: 200
  });
  const compaction = findCompactionCandidates(db, {minPieceCount: 30});
  const retention = findRetentionCandidates(db);
  const upgrade = findUpgradeSignals(db);
  recordScanPass(db, generation, new Date().toISOString());
  return {duplicates, compaction, retention, upgrade, durationMs: Date.now() - start};
};
