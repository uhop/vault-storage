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
          `SELECT DISTINCT v.record_id, r.file_path
             FROM record_vec v
             JOIN records r ON r.record_id = v.record_id
            WHERE v.content_hash != r.content_hash`
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

    // Records with no chunks in record_vec. Indicates the embedder was
    // disabled at import time, embedPending hasn't run, or a crash
    // between record insert and embed.
    {
      const rows = db
        .prepare(
          `SELECT r.record_id, r.file_path
             FROM records r
            WHERE NOT EXISTS (
              SELECT 1 FROM record_vec v WHERE v.record_id = r.record_id
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

    // record_vec chunks whose record_id no longer exists in records.
    // Should be impossible (the records-delete path mirrors), but
    // record_vec is a virtual table without FK enforcement.
    {
      const rows = db
        .prepare(
          `SELECT DISTINCT v.record_id
             FROM record_vec v
            WHERE NOT EXISTS (
              SELECT 1 FROM records r WHERE r.record_id = v.record_id
            )`
        )
        .all() as {record_id: string}[];
      checks['orphan_embeddings'] = {
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

    const total = Object.values(checks).reduce((sum, c) => sum + c.count, 0);

    const report: LintReport = {
      ok: total === 0,
      total_issues: total,
      checks
    };
    sendJson(ctx.res, 200, report);
  };
