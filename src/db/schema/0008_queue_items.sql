-- 0008 — queue_items: derived index of project queue.md / queue-archive.md
-- contents, for fleet-wide queries ("top N by priority", "everything at +2
-- across all projects", "all rejected items"). Source of truth stays in the
-- markdown files per constraint C4; the watcher re-parses on file change and
-- the repo layer applies a per-source-file delta.
--
-- Design: projects/vault-storage/design/queue-items-table.md (2026-05-13).
--
-- Identity is `(project, section, title_norm)`. A title edit creates a fresh
-- id (the old row is removed by the next reparse because its title_norm is
-- no longer in the parse output). A section move (Backlog → Active) is also
-- DELETE + INSERT since section is part of the unique key. This matches how
-- the records table handles renames today: cheap and side-effect-free.

CREATE TABLE queue_items (
  id           TEXT PRIMARY KEY,                 -- UUIDv7
  project      TEXT NOT NULL,                    -- 'node-re2', 'yopl', ...
  section      TEXT NOT NULL CHECK (section IN ('active', 'backlog', 'watching', 'archive')),
  priority     INTEGER NOT NULL DEFAULT 0,       -- ±N around 0; meaningful only when section='backlog'
  position     INTEGER NOT NULL,                 -- 1-based within (project, section, priority [, closed_at])
  title        TEXT NOT NULL,
  title_norm   TEXT NOT NULL,
  body         TEXT NOT NULL,
  closed_at    TEXT,                             -- 'YYYY-MM-DD' for archive items with a date heading; NULL otherwise
  close_reason TEXT CHECK (close_reason IN ('shipped', 'rejected', 'parked', 'deferred') OR close_reason IS NULL),
  source_file  TEXT NOT NULL,                    -- 'projects/<name>/queue.md' or 'projects/<name>/queue-archive.md'
  source_line  INTEGER NOT NULL,                 -- 1-based, against the original file
  body_hash    TEXT NOT NULL,                    -- sha256(title + '\0' + body)
  created_at   TEXT NOT NULL,                    -- when this id was first observed
  updated_at   TEXT NOT NULL,                    -- last time body_hash changed
  UNIQUE (project, section, title_norm)
);

CREATE INDEX idx_queue_items_by_project      ON queue_items(project);
CREATE INDEX idx_queue_items_open_by_prio    ON queue_items(priority DESC, project, section, position)
                                              WHERE section != 'archive';
CREATE INDEX idx_queue_items_archive_by_date ON queue_items(closed_at DESC, project)
                                              WHERE section = 'archive';
CREATE INDEX idx_queue_items_by_priority     ON queue_items(priority, project, section, position)
                                              WHERE section != 'archive';

UPDATE meta SET value = '8' WHERE key = 'schema_version';
