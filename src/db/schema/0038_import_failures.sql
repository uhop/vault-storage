-- 0038 — a file whose import threw is recorded (D113, 2026-09-30): the full
-- import, the watcher, and the incremental reindex write its path and the
-- error's first line, `importFile` clears the row when the path imports, and
-- the integrity lint reports what is left. Keyed by path, since a new file that
-- fails has no record; a row beside a record means the record is stale.
-- Derived from the files, so a full import rebuilds it; this migration forces
-- one to record what the vault already holds.

CREATE TABLE import_failures (
  file_path TEXT PRIMARY KEY,
  message   TEXT NOT NULL,
  seen_at   TEXT NOT NULL
);

UPDATE meta SET value = '38' WHERE key = 'schema_version';
