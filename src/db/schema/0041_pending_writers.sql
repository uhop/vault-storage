-- 0041 — the last named writer of each uncommitted path (D136): a write by a
-- named key records its paths, and the commit pass commits each writer's paths
-- under that writer's name, then drops the rows it committed.
-- migrate:no-reindex

CREATE TABLE pending_writers (
  path TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  email TEXT,
  written_at TEXT NOT NULL
);

UPDATE meta SET value = '41' WHERE key = 'schema_version';
