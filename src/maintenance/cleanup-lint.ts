import type {DatabaseSync} from 'node:sqlite';

export interface CleanupLintSummary {
  totalFixed: number;
  fixed: {
    orphan_embeddings: {recordsAffected: number; chunksDeleted: number};
    orphan_doc_embeddings: {rowsDeleted: number};
    orphan_suggestions: {suggestionsResolved: number};
    temporal_future_clamps: {recordsAffected: number; fieldsUpdated: number};
  };
  needsReview: Record<string, number>;
  durationMs: number;
}

/**
 * Auto-fix the lint categories that have a deterministic cleanup:
 * `orphan_embeddings` (rows in `record_vec` whose `record_id` no longer
 * exists in `records`), `orphan_doc_embeddings` (same in
 * `record_doc_vec`), `orphan_suggestions` (pending suggestions whose
 * `subject_id` points at a now-missing record), and
 * `temporal_future_clamps` (records with `created` or `updated` stamps
 * in the future — clamped to now). Schemas 7 + 9 install AFTER DELETE
 * triggers that prevent new orphans of these shapes; this endpoint
 * drains pre-existing ones (and any future ones that slip past a
 * trigger via raw DB access).
 *
 * Future-stamp clamping is mechanical: the wall clock is authoritative,
 * so a stamp ahead of it can't be right. The `updated < created` sub-
 * category of temporal_anomalies stays in `needsReview` — re-stamping
 * a back-dated update could mask a write bug; surface it for human
 * investigation. If clamping a future `created` produces an
 * `updated < created` state as a side effect (rare; requires only
 * `created` to be in the future), the resulting anomaly surfaces in
 * `needsReview` on the next /system/lint call.
 *
 * Categories that need human review (`temporal_anomalies` non-future
 * subset, `dangling_tag_aliases`) are reported under `needsReview` with
 * their current counts; embedding-related ones
 * (`embedding_hash_drift`, `records_without_embeddings`) are likewise
 * surfaced — the watcher / embedPending pass handles them on the next
 * trigger and a manual cleanup here would race.
 */
export const cleanupLint = (db: DatabaseSync): CleanupLintSummary => {
  const start = Date.now();

  const orphans = db
    .prepare(
      `SELECT DISTINCT v.record_id
         FROM record_vec v
        WHERE NOT EXISTS (
          SELECT 1 FROM records r WHERE r.record_id = v.record_id
        )`
    )
    .all() as {record_id: string}[];

  let chunksDeleted = 0;
  if (orphans.length > 0) {
    const placeholders = orphans.map(() => '?').join(',');
    const result = db
      .prepare(`DELETE FROM record_vec WHERE record_id IN (${placeholders})`)
      .run(...orphans.map(o => o.record_id));
    chunksDeleted = Number(result.changes);
  }

  const docOrphans = db
    .prepare(
      `SELECT v.record_id
         FROM record_doc_vec v
        WHERE NOT EXISTS (
          SELECT 1 FROM records r WHERE r.record_id = v.record_id
        )`
    )
    .all() as {record_id: string}[];

  let docRowsDeleted = 0;
  if (docOrphans.length > 0) {
    const placeholders = docOrphans.map(() => '?').join(',');
    const result = db
      .prepare(`DELETE FROM record_doc_vec WHERE record_id IN (${placeholders})`)
      .run(...docOrphans.map(o => o.record_id));
    docRowsDeleted = Number(result.changes);
  }

  // Pending suggestions whose subject_id points at a missing record.
  // Resolve as accepted with `resolved_by='record-deleted-backfill'` —
  // distinct from `record-deleted` (the live cascade marker installed by
  // schema 9) so the audit trail says "drained by cleanup-lint" vs
  // "resolved by the trigger at delete time".
  const suggestionsResolved = Number(
    db
      .prepare(
        `UPDATE suggestions
            SET status      = 'accepted',
                resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                resolved_by = 'record-deleted-backfill'
          WHERE status      = 'pending'
            AND subject_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM records r WHERE r.record_id = suggestions.subject_id
            )`
      )
      .run().changes
  );

  const futureClamps = clampFutureStamps(db);

  const needsReview: Record<string, number> = {
    embedding_hash_drift: countDrift(db),
    records_without_embeddings: countMissingEmbeddings(db),
    temporal_anomalies: countTemporalAnomalies(db),
    dangling_tag_aliases: countDanglingAliases(db)
  };

  return {
    totalFixed:
      orphans.length + docOrphans.length + suggestionsResolved + futureClamps.recordsAffected,
    fixed: {
      orphan_embeddings: {recordsAffected: orphans.length, chunksDeleted},
      orphan_doc_embeddings: {rowsDeleted: docRowsDeleted},
      orphan_suggestions: {suggestionsResolved},
      temporal_future_clamps: futureClamps
    },
    needsReview,
    durationMs: Date.now() - start
  };
};

const clampFutureStamps = (db: DatabaseSync): {recordsAffected: number; fieldsUpdated: number} => {
  const now = new Date().toISOString();
  const futures = db
    .prepare(
      `SELECT record_id, created, updated
         FROM records
        WHERE created > ? OR updated > ?`
    )
    .all(now, now) as {record_id: string; created: string; updated: string}[];

  let fieldsUpdated = 0;
  const update = db.prepare(`UPDATE records SET created = ?, updated = ? WHERE record_id = ?`);
  for (const r of futures) {
    let newCreated = r.created;
    let newUpdated = r.updated;
    if (r.created > now) {
      newCreated = now;
      ++fieldsUpdated;
    }
    if (r.updated > now) {
      newUpdated = now;
      ++fieldsUpdated;
    }
    update.run(newCreated, newUpdated, r.record_id);
  }
  return {recordsAffected: futures.length, fieldsUpdated};
};

const countDrift = (db: DatabaseSync): number =>
  Number(
    (
      db
        .prepare(
          `SELECT COUNT(DISTINCT v.record_id) AS n
             FROM record_vec v
             JOIN records r ON r.record_id = v.record_id
            WHERE v.content_hash != r.content_hash`
        )
        .get() as {n: number}
    ).n
  );

// Pre-materialize record_vec's distinct record_ids: vec0's `+record_id` is
// an auxiliary unindexed column, so a correlated NOT EXISTS into it becomes
// a full vec0 scan per outer row. Single materialization → indexed anti-join
// is ~370× faster on a few-thousand-record vault. (Same fix applied in
// src/server/handlers/lint.ts.)
const countMissingEmbeddings = (db: DatabaseSync): number =>
  Number(
    (
      db
        .prepare(
          `WITH record_vec_ids AS (SELECT DISTINCT record_id FROM record_vec)
           SELECT COUNT(*) AS n
             FROM records r
             LEFT JOIN record_vec_ids v ON v.record_id = r.record_id
            WHERE v.record_id IS NULL`
        )
        .get() as {n: number}
    ).n
  );

const countTemporalAnomalies = (db: DatabaseSync): number => {
  const now = new Date().toISOString();
  return Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM records
            WHERE updated < created OR created > ? OR updated > ?`
        )
        .get(now, now) as {n: number}
    ).n
  );
};

const countDanglingAliases = (db: DatabaseSync): number =>
  Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM tag_aliases a
            WHERE NOT EXISTS (
              SELECT 1 FROM tags_taxonomy t WHERE t.tag = a.canonical
            )`
        )
        .get() as {n: number}
    ).n
  );
