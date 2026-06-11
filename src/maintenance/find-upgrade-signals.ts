// Time-to-upgrade evaluator. Periodically inspects the live DB for
// signals that the current SQLite + sqlite-vec + recursive-CTE shape is
// hitting an inefficiency point, and files an `inefficiency_detected`
// or `infrastructure_upgrade` suggestion.
//
// Reports only — never auto-migrates. The agent (or user) reads the
// suggestions queue and decides remediation: tune (VACUUM, prune,
// raise index thresholds), or move to the documented upgrade target
// (Postgres + pgvector + AGE per design/backend-comparison.md).
//
// Default thresholds calibrated for personal-vault scale at the
// 2026-05-01 baseline (780 records, 20MB DB, ~3.5K edges):
//
//   record_count_high       50_000   (~64× current; vector linear-scan
//                                     becomes uncomfortable past this)
//   record_count_migrate   100_000   (infrastructure_upgrade kind —
//                                     migrate to Postgres+pgvector)
//   db_bytes              1 GiB      (~50× current; SQLite stays fine
//                                     here, but VACUUM + tuning matter)
//   max_outbound_edges       200     (graph hubs that recursive CTEs
//                                     traverse expensively)
//   pending_backlog        5_000     (review queue piled up; tooling
//                                     pressure, not engine pressure)

import type {DatabaseSync} from 'node:sqlite';
import {SuggestionFiler} from '../importer/file-suggestions.ts';

export const DEFAULT_THRESHOLDS = {
  recordCountHigh: 50_000,
  recordCountMigrate: 100_000,
  dbBytes: 1024 * 1024 * 1024, // 1 GiB
  maxOutboundEdges: 200,
  pendingBacklog: 5_000
};

export interface UpgradeSignalsOptions {
  thresholds?: Partial<typeof DEFAULT_THRESHOLDS>;
  /** Override the timestamp written to suggestion rows (test injection). */
  now?: string;
}

export interface UpgradeSignalsSummary {
  scanned: string[];
  tripped: string[];
  filed: number;
  durationMs: number;
  /** Snapshot of the values measured this pass. */
  observed: {
    recordCount: number;
    dbBytes: number;
    maxOutboundEdges: number;
    pendingSuggestions: number;
  };
}

interface OutboundLeader {
  from_id: string;
  file_path: string | null;
  count: number;
}

interface Stats {
  recordCount: number;
  dbBytes: number;
  maxOutboundEdges: number;
  topOutbound: OutboundLeader[];
  pendingSuggestions: number;
}

const collectStats = (db: DatabaseSync): Stats => {
  const rc = db.prepare('SELECT COUNT(*) AS n FROM records').get() as {n: number};
  const sz = db
    .prepare('SELECT page_count * page_size AS n FROM pragma_page_count, pragma_page_size')
    .get() as {n: number};
  const top = db
    .prepare(
      `SELECT e.from_id AS from_id, r.file_path AS file_path, COUNT(*) AS count
       FROM edges e
       LEFT JOIN records r ON r.record_id = e.from_id
       GROUP BY e.from_id
       ORDER BY count DESC
       LIMIT 5`
    )
    .all() as unknown[] as OutboundLeader[];
  const fan = top[0]?.count ?? 0;
  const ps = db
    .prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE status = 'pending'`)
    .get() as {n: number};
  return {
    recordCount: rc.n,
    dbBytes: sz.n,
    maxOutboundEdges: fan,
    topOutbound: top,
    pendingSuggestions: ps.n
  };
};

interface Signal {
  name: string;
  kind: 'inefficiency_detected' | 'infrastructure_upgrade';
  current: number;
  threshold: number;
  recommendation: string;
  subjectId?: string;
  extra?: Record<string, unknown>;
}

const evaluate = (
  stats: Stats,
  thresholds: typeof DEFAULT_THRESHOLDS
): {scanned: string[]; tripped: Signal[]} => {
  const scanned = ['record_count', 'db_bytes', 'max_outbound_edges', 'pending_backlog'];
  const tripped: Signal[] = [];

  if (stats.recordCount >= thresholds.recordCountMigrate) {
    tripped.push({
      name: 'record_count_migrate',
      kind: 'infrastructure_upgrade',
      current: stats.recordCount,
      threshold: thresholds.recordCountMigrate,
      recommendation:
        'Record count past the SQLite + sqlite-vec comfort zone. Plan migration to Postgres + pgvector + AGE per design/backend-comparison.md.'
    });
  } else if (stats.recordCount >= thresholds.recordCountHigh) {
    tripped.push({
      name: 'record_count_high',
      kind: 'inefficiency_detected',
      current: stats.recordCount,
      threshold: thresholds.recordCountHigh,
      recommendation:
        'Record count is high; vector linear-scan latency may rise. Consider tuning chunk_size or moving to the upgrade target before the migrate threshold trips.'
    });
  }

  if (stats.dbBytes >= thresholds.dbBytes) {
    tripped.push({
      name: 'db_bytes_high',
      kind: 'inefficiency_detected',
      current: stats.dbBytes,
      threshold: thresholds.dbBytes,
      recommendation:
        'DB file size is large. Run VACUUM to reclaim space; check for orphaned chunks via /system/lint; review per-type retention thresholds.'
    });
  }

  if (stats.maxOutboundEdges >= thresholds.maxOutboundEdges) {
    const leader = stats.topOutbound[0];
    tripped.push({
      name: 'edge_fanout_high',
      kind: 'inefficiency_detected',
      current: stats.maxOutboundEdges,
      threshold: thresholds.maxOutboundEdges,
      recommendation:
        'A record has very high outbound edge fanout — recursive-CTE traversals through it will be expensive. Consider whether the hub is over-linked (compaction candidate) or whether the graph wants AGE-style native graph traversal.',
      subjectId: leader?.from_id,
      extra: {top: stats.topOutbound}
    });
  }

  if (stats.pendingSuggestions >= thresholds.pendingBacklog) {
    tripped.push({
      name: 'review_backlog_high',
      kind: 'inefficiency_detected',
      current: stats.pendingSuggestions,
      threshold: thresholds.pendingBacklog,
      recommendation:
        'Pending suggestions queue has grown large. Drain via the /vault-review-* skills, or audit the filers — a noisy filer can flood the queue with low-value entries.'
    });
  }

  return {scanned, tripped};
};

/**
 * Inspect the live DB and file `inefficiency_detected` /
 * `infrastructure_upgrade` suggestions for any tripped signal.
 * Idempotent: a pending suggestion for the same `(kind, signal)` blocks
 * re-filing. Resolving (accept / reject) lets the next scan re-fire if
 * the signal is still active.
 */
export const findUpgradeSignals = (
  db: DatabaseSync,
  options: UpgradeSignalsOptions = {}
): UpgradeSignalsSummary => {
  const thresholds = {...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {})};
  const now = options.now ?? new Date().toISOString();

  const filers = {
    inefficiency_detected: new SuggestionFiler(db, 'inefficiency_detected'),
    infrastructure_upgrade: new SuggestionFiler(db, 'infrastructure_upgrade')
  };
  const start = performance.now();

  const stats = collectStats(db);
  const {scanned, tripped} = evaluate(stats, thresholds);

  let filed = 0;
  for (const t of tripped) {
    if (
      filers[t.kind].file(
        {
          signal: t.name,
          current: t.current,
          threshold: t.threshold,
          recommendation: t.recommendation,
          ...(t.extra ?? {})
        },
        now,
        {subjectId: t.subjectId ?? null}
      )
    ) {
      filed++;
    }
  }

  return {
    scanned,
    tripped: tripped.map(t => t.name),
    filed,
    durationMs: Math.round(performance.now() - start),
    observed: {
      recordCount: stats.recordCount,
      dbBytes: stats.dbBytes,
      maxOutboundEdges: stats.maxOutboundEdges,
      pendingSuggestions: stats.pendingSuggestions
    }
  };
};
