import type {DatabaseSync} from 'node:sqlite';

export interface CleanupLintSummary {
  totalFixed: number;
  fixed: {
    orphan_embeddings: {recordsAffected: number; chunksDeleted: number};
    orphan_doc_embeddings: {rowsDeleted: number};
  };
  needsReview: Record<string, number>;
  durationMs: number;
}

/**
 * Auto-fix the lint categories that have a deterministic cleanup:
 * `orphan_embeddings` (rows in `record_vec` whose `record_id` no longer
 * exists in `records`) and `orphan_doc_embeddings` (same in
 * `record_doc_vec`). Schema 7's records_after_delete trigger prevents
 * new orphans; this endpoint drains pre-existing ones.
 *
 * Categories that need human review (`temporal_anomalies`,
 * `dangling_tag_aliases`) are reported under `needsReview` with their
 * current counts; embedding-related ones (`embedding_hash_drift`,
 * `records_without_embeddings`) are likewise surfaced — the watcher /
 * embedPending pass handles them on the next trigger and a manual
 * cleanup here would race.
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

  const needsReview: Record<string, number> = {
    embedding_hash_drift: countDrift(db),
    records_without_embeddings: countMissingEmbeddings(db),
    temporal_anomalies: countTemporalAnomalies(db),
    dangling_tag_aliases: countDanglingAliases(db)
  };

  return {
    totalFixed: orphans.length + docOrphans.length,
    fixed: {
      orphan_embeddings: {recordsAffected: orphans.length, chunksDeleted},
      orphan_doc_embeddings: {rowsDeleted: docRowsDeleted}
    },
    needsReview,
    durationMs: Date.now() - start
  };
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

const countMissingEmbeddings = (db: DatabaseSync): number =>
  Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM records r
            WHERE NOT EXISTS (
              SELECT 1 FROM record_vec v WHERE v.record_id = r.record_id
            )`
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
