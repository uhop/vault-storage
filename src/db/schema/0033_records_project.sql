-- 0033 — a record's project (D104, 2026-09-29): `projects/<name>/…` by its
-- path, a log by its `project:` key or the project its file name starts
-- with, null elsewhere. Filled at import; this migration forces the full
-- import that fills it for what the vault already holds.

ALTER TABLE records ADD COLUMN project TEXT;
CREATE INDEX IF NOT EXISTS idx_records_project ON records(project);

UPDATE meta SET value = '33' WHERE key = 'schema_version';
