-- 0027 — enrichment baselines. The chunk set of a record's body at the moment
-- its `agent:` block was current, so a stale refresh reads what changed since
-- instead of the whole body. One row per record: `chunks` is a JSON array of
-- [text sha256, length] pairs in body order. A derivative like every other
-- table: a record stale at a full reindex has no baseline until its next
-- refresh, and the refresh reads the whole body once.
-- migrate:no-reindex

CREATE TABLE enrichment_baselines (
  record_id  TEXT PRIMARY KEY REFERENCES records(record_id) ON DELETE CASCADE,
  body_hash  TEXT NOT NULL,
  body_bytes INTEGER NOT NULL,
  chunks     TEXT NOT NULL,
  created    TEXT NOT NULL
);

UPDATE meta SET value = '27' WHERE key = 'schema_version';
