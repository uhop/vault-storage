import type {DatabaseSync} from 'node:sqlite';
import {sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

interface LintDeps {
  db: DatabaseSync;
}

interface LintCheck {
  count: number;
  samples: Array<Record<string, unknown>>;
}

interface LintReport {
  ok: boolean;
  total_issues: number;
  checks: Record<string, LintCheck>;
}

const SAMPLE_LIMIT = 10;

/** Consecutive git-sync poll failures before `auto_commit_failing` fires. */
const AUTO_COMMIT_FAILURE_THRESHOLD = 3;

/**
 * GET /system/lint — bug-finding integrity checks.
 *
 * Each check is a focused DB query for a known failure mode. All checks
 * combined are O(N) on indexed columns; on a few-thousand-record vault
 * the full pass is < 100ms. Safe to call from `/vault resume`.
 *
 * `ok` is `true` iff every check returned 0. When non-zero, `samples`
 * provides up to 10 identifiers per check so the agent can investigate
 * without a follow-up query.
 */
export const lintHandler =
  (deps: LintDeps): Handler =>
  ctx => {
    const {db} = deps;
    const checks: Record<string, LintCheck> = {};

    // Embedding chunks whose recorded content_hash drifted from the
    // record's current hash. embedPending re-embeds when these mismatch;
    // persistent drift means the pass didn't run (or crashed) since the
    // body changed.
    {
      const rows = db
        .prepare(
          `SELECT DISTINCT c.record_id, r.file_path
             FROM chunks c
             JOIN records r ON r.record_id = c.record_id
            WHERE c.content_hash != r.content_hash`
        )
        .all() as {record_id: string; file_path: string}[];
      checks['embedding_hash_drift'] = {
        count: rows.length,
        samples: rows.slice(0, SAMPLE_LIMIT).map(r => ({
          id: r.record_id,
          file_path: r.file_path
        }))
      };
    }

    // Records with no chunks. Indicates the embedder was disabled at
    // import time, embedPending hasn't run, or a crash between record
    // insert and embed. (Plain correlated NOT EXISTS — chunks.record_id
    // is B-tree-indexed since schema 0010; the pre-0010 CTE workaround
    // for the unindexed vec0 aux column is gone.)
    {
      const rows = db
        .prepare(
          `SELECT r.record_id, r.file_path
             FROM records r
            WHERE NOT EXISTS (
              SELECT 1 FROM chunks c WHERE c.record_id = r.record_id
            )`
        )
        .all() as {record_id: string; file_path: string}[];
      checks['records_without_embeddings'] = {
        count: rows.length,
        samples: rows.slice(0, SAMPLE_LIMIT).map(r => ({
          id: r.record_id,
          file_path: r.file_path
        }))
      };
    }

    // Chunks whose record_id no longer exists in records. The
    // records_after_delete trigger (0007, rebuilt in 0010) guards
    // against new orphans by cascading records-delete to chunks +
    // record_vec; orphans that slip past it (raw DB access) need
    // /maintenance/cleanup-lint to drain.
    {
      const rows = db
        .prepare(
          `SELECT DISTINCT c.record_id
             FROM chunks c
            WHERE NOT EXISTS (
              SELECT 1 FROM records r WHERE r.record_id = c.record_id
            )`
        )
        .all() as {record_id: string}[];
      checks['orphan_embeddings'] = {
        count: rows.length,
        samples: rows.slice(0, SAMPLE_LIMIT).map(r => ({id: r.record_id}))
      };
    }

    // record_vec rows with no chunks metadata row. The two tables are
    // written and deleted together (setChunks, deleteRecord, the 0010
    // trigger), so divergence indicates a bug or raw DB access. New
    // failure class introduced by the 0010 metadata split; cleaned by
    // /maintenance/cleanup-lint.
    {
      const rows = db
        .prepare(
          `SELECT v.chunk_id
             FROM record_vec v
            WHERE NOT EXISTS (
              SELECT 1 FROM chunks c WHERE c.chunk_id = v.chunk_id
            )`
        )
        .all() as {chunk_id: string}[];
      checks['orphan_vec_rows'] = {
        count: rows.length,
        samples: rows.slice(0, SAMPLE_LIMIT).map(r => ({id: r.chunk_id}))
      };
    }

    // record_doc_vec rows whose record_id no longer exists in records.
    // Same structural cause + cascade as orphan_embeddings; tracked
    // separately so the operator sees which vec table is affected.
    {
      const rows = db
        .prepare(
          `SELECT v.record_id
             FROM record_doc_vec v
            WHERE NOT EXISTS (
              SELECT 1 FROM records r WHERE r.record_id = v.record_id
            )`
        )
        .all() as {record_id: string}[];
      checks['orphan_doc_embeddings'] = {
        count: rows.length,
        samples: rows.slice(0, SAMPLE_LIMIT).map(r => ({id: r.record_id}))
      };
    }

    // Records with temporal anomalies: updated < created, or stamps in
    // the future. Future stamps usually indicate clock skew at write
    // time; updated < created indicates frontmatter corruption.
    {
      const now = new Date().toISOString();
      const rows = db
        .prepare(
          `SELECT record_id, file_path, created, updated
             FROM records
            WHERE updated < created OR created > ? OR updated > ?`
        )
        .all(now, now) as {
        record_id: string;
        file_path: string;
        created: string;
        updated: string;
      }[];
      checks['temporal_anomalies'] = {
        count: rows.length,
        samples: rows.slice(0, SAMPLE_LIMIT).map(r => ({
          id: r.record_id,
          file_path: r.file_path,
          created: r.created,
          updated: r.updated
        }))
      };
    }

    // Pending suggestions whose subject_id points at a record that no
    // longer exists. Schema 9's records_after_delete_resolve_suggestions
    // trigger prevents new orphans by cascading records-delete to
    // suggestions; pre-trigger orphans (suggestions whose subject was
    // deleted before schema 9 landed) still need /maintenance/cleanup-lint
    // to drain. NULL subject_id is allowed (system-level kinds like
    // inefficiency_detected); only NOT NULL rows are checked.
    {
      const rows = db
        .prepare(
          `SELECT s.id, s.kind, s.subject_id
             FROM suggestions s
            WHERE s.status = 'pending'
              AND s.subject_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM records r WHERE r.record_id = s.subject_id
              )`
        )
        .all() as {id: string; kind: string; subject_id: string}[];
      checks['orphan_suggestions'] = {
        count: rows.length,
        samples: rows.slice(0, SAMPLE_LIMIT).map(r => ({
          id: r.id,
          kind: r.kind,
          subject_id: r.subject_id
        }))
      };
    }

    // tag_aliases pointing to a canonical missing from tags_taxonomy.
    // Foreign keys prevent this when PRAGMA foreign_keys = ON, but
    // check as a safety net.
    {
      const rows = db
        .prepare(
          `SELECT a.alias, a.canonical
             FROM tag_aliases a
            WHERE NOT EXISTS (
              SELECT 1 FROM tags_taxonomy t WHERE t.tag = a.canonical
            )`
        )
        .all() as {alias: string; canonical: string}[];
      checks['dangling_tag_aliases'] = {
        count: rows.length,
        samples: rows.slice(0, SAMPLE_LIMIT).map(r => ({
          id: r.alias,
          canonical: r.canonical
        }))
      };
    }

    // Auto-commit health (Tier-1 backup, C2). git-sync persists a
    // consecutive-failure streak under meta `git_sync_*` keys; one failed
    // poll is transient noise, a streak of AUTO_COMMIT_FAILURE_THRESHOLD+
    // means the backup cadence is down across multiple polls. Motivating
    // incident: a stale index.lock starved auto-commit silently for four
    // days (2026-06-08→11) with the only signal in container stderr.
    {
      const rows = db
        .prepare(
          `SELECT key, value FROM meta
            WHERE key IN ('git_sync_consecutive_failures', 'git_sync_last_error', 'git_sync_failing_since')`
        )
        .all() as {key: string; value: string}[];
      const meta = new Map(rows.map(r => [r.key, r.value]));
      const failures = Number(meta.get('git_sync_consecutive_failures') ?? '0');
      const failing = Number.isFinite(failures) && failures >= AUTO_COMMIT_FAILURE_THRESHOLD;
      checks['auto_commit_failing'] = {
        count: failing ? 1 : 0,
        samples: failing
          ? [
              {
                consecutive_failures: failures,
                failing_since: meta.get('git_sync_failing_since') ?? null,
                last_error: meta.get('git_sync_last_error') ?? null
              }
            ]
          : []
      };
    }

    const total = Object.values(checks).reduce((sum, c) => sum + c.count, 0);

    const report: LintReport = {
      ok: total === 0,
      total_issues: total,
      checks
    };
    sendJson(ctx.res, 200, report);
  };
