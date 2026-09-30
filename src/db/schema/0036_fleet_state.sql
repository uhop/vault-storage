-- 0036 — the stored fleet-status data as a derivative (D110, 2026-09-30):
-- the `## GitHub` and `## Packages` JSON blocks of each `projects/<name>/state.md`
-- as one baseline row, and each run of `projects/agent-workflow/fleet-status.md`
-- as one row, both written by `importFile` and gone with their record.
-- `GET /fleet/status` reads these instead of every consumer parsing the
-- markdown. This migration forces the full import that fills them.

CREATE TABLE fleet_baselines (
  record_id             TEXT PRIMARY KEY REFERENCES records(record_id) ON DELETE CASCADE,
  project               TEXT NOT NULL,
  repo                  TEXT,
  github                TEXT,            -- the `## GitHub` block, JSON text; NULL without one
  github_collected_at   TEXT,
  packages              TEXT,            -- the `## Packages` block, JSON text; NULL without one
  packages_collected_at TEXT
);
CREATE INDEX idx_fleet_baselines_project ON fleet_baselines(project);

CREATE TABLE fleet_runs (
  record_id    TEXT NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
  collected_at TEXT NOT NULL,
  mode         TEXT,
  run          TEXT NOT NULL,           -- the run's JSON block as text
  PRIMARY KEY (record_id, collected_at)
);
CREATE INDEX idx_fleet_runs_collected ON fleet_runs(collected_at DESC);

UPDATE meta SET value = '36' WHERE key = 'schema_version';
