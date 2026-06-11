-- migrate:no-transaction
-- 0011 — records row layout: big text columns last + persisted body_hash.
--
-- SQLite stores row payloads in declared column order, and rows larger than
-- the page spill to overflow pages. `body` sat at column 6 (0001) with
-- `title` (0002) and the `agent_*` columns (0005) ALTER-appended after it —
-- so reading any column past `body` (created, updated, status, title, …)
-- on a multi-KB record chased the overflow chain even for metadata-only
-- queries (lint's temporal scan, retention rules, listings). The rebuild
-- moves the two big text columns (`agent_summary`, then `body` as the
-- largest) to the end: queries that stop before them never leave the
-- B-tree page.
--
-- `body_hash` (sha256 of body alone, distinct from `content_hash` =
-- embedInputHash(body, agent_summary)) is persisted at the same time —
-- previously serialize re-hashed summary-carrying records on every
-- response and import-file re-hashed for the agent-staleness check. The
-- backfill uses the app-registered `sha256_hex` SQL function
-- (src/db/connection.ts), which mirrors util/hash.ts contentHash exactly.
--
-- Runs outside the runner's transaction (see the marker above): the
-- table-rebuild procedure requires `PRAGMA foreign_keys = OFF` so that
-- DROP TABLE records doesn't cascade into edges/tags, and that pragma is
-- a silent no-op inside an open transaction. The file manages its own
-- BEGIN/COMMIT around the rebuild.

PRAGMA foreign_keys = OFF;

BEGIN;

CREATE TABLE records_new (
  record_id       TEXT PRIMARY KEY,                                 -- UUIDv7
  file_path       TEXT NOT NULL UNIQUE,                             -- vault-relative path
  parent_path     TEXT,                                             -- folder for atomized pieces; NULL for standalone
  sequence_key    INTEGER,                                          -- ordering hint within parent_path
  type            TEXT NOT NULL CHECK (type IN (
    'idea', 'design', 'plan', 'queue-item', 'research', 'bug-report', 'project',
    'permanent', 'log', 'query', 'fleeting', 'state', 'meta', 'index'
  )),
  title           TEXT,
  content_hash    TEXT NOT NULL,                                    -- embedInputHash(body, agent_summary)
  body_hash       TEXT NOT NULL,                                    -- sha256 of body alone
  created         TEXT NOT NULL,                                    -- ISO 8601
  updated         TEXT NOT NULL,
  last_referenced TEXT,
  decay_score     REAL NOT NULL DEFAULT 1.0,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'draft', 'done', 'superseded', 'archived'
  )),
  priority        INTEGER NOT NULL DEFAULT 0,                       -- higher = more urgent; open-ended
  archived_at     TEXT,
  agent_derived_from_hash TEXT,
  -- big text columns last: metadata-only reads stop before these
  agent_summary   TEXT,
  body            TEXT NOT NULL
);

INSERT INTO records_new (
  record_id, file_path, parent_path, sequence_key, type, title, content_hash,
  body_hash, created, updated, last_referenced, decay_score, status, priority,
  archived_at, agent_derived_from_hash, agent_summary, body
)
SELECT
  record_id, file_path, parent_path, sequence_key, type, title, content_hash,
  sha256_hex(body), created, updated, last_referenced, decay_score, status,
  priority, archived_at, agent_derived_from_hash, agent_summary, body
FROM records;

DROP TABLE records;
ALTER TABLE records_new RENAME TO records;

-- Indexes from 0001 (dropped with the old table).
CREATE INDEX idx_records_parent_path  ON records(parent_path, sequence_key);
CREATE INDEX idx_records_status_decay ON records(status, decay_score);
CREATE INDEX idx_records_priority     ON records(priority DESC, created) WHERE priority != 0;
CREATE INDEX idx_records_type         ON records(type, status);

-- Triggers on records (dropped with the old table): the vec/chunks cascade
-- (0007, rebuilt in 0010) and the suggestions auto-resolve cascade (0009).
CREATE TRIGGER records_after_delete
AFTER DELETE ON records
BEGIN
  DELETE FROM record_vec WHERE chunk_id IN (
    SELECT chunk_id FROM chunks WHERE record_id = OLD.record_id
  );
  DELETE FROM chunks WHERE record_id = OLD.record_id;
  DELETE FROM record_doc_vec WHERE record_id = OLD.record_id;
END;

CREATE TRIGGER records_after_delete_resolve_suggestions
AFTER DELETE ON records
BEGIN
  UPDATE suggestions
     SET status      = 'accepted',
         resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         resolved_by = 'record-deleted'
   WHERE subject_id = OLD.record_id
     AND status     = 'pending';
END;

UPDATE meta SET value = '11' WHERE key = 'schema_version';

COMMIT;

PRAGMA foreign_keys = ON;
