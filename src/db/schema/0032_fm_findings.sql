-- 0032 — stored frontmatter values outside a closed enum are recorded (D103,
-- 2026-09-29): the importer writes the type, status, priority, and
-- agent.complexity values it defaults, the edge pass the edges: types it
-- drops, one row per (record, field, value), and the integrity lint reports
-- them. Derived from the files, so a full import rebuilds it; this migration
-- forces one to record what the vault already holds.

CREATE TABLE IF NOT EXISTS fm_findings (
  record_id TEXT NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
  field     TEXT NOT NULL,
  value     TEXT NOT NULL,
  seen_at   TEXT NOT NULL,
  PRIMARY KEY (record_id, field, value)
);

UPDATE meta SET value = '32' WHERE key = 'schema_version';
