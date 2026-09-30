-- 0035 — queue_items.section admits 'inbox' (2026-09-30): the `## Inbox`
-- section of a queue.md, where a secondary tracker's items land for triage
-- when its declaration says `intake: triage`, before a person or agent moves
-- them to Backlog or Active, or archives them as rejected. SQLite cannot widen
-- a CHECK in place, so the table is rebuilt and every row copied, ids and
-- timestamps included; the partial indexes are recreated as 0008 and 0034
-- defined them. No reindex: the rows are the same rows.
-- migrate:no-reindex

CREATE TABLE queue_items_new (
  id           TEXT PRIMARY KEY,
  project      TEXT NOT NULL,
  section      TEXT NOT NULL CHECK (section IN ('inbox', 'active', 'backlog', 'watching', 'archive')),
  priority     INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL,
  title        TEXT NOT NULL,
  title_norm   TEXT NOT NULL,
  body         TEXT NOT NULL,
  closed_at    TEXT,
  close_reason TEXT CHECK (close_reason IN ('shipped', 'rejected', 'parked', 'deferred') OR close_reason IS NULL),
  source_file  TEXT NOT NULL,
  source_line  INTEGER NOT NULL,
  body_hash    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  blocked_by   TEXT NOT NULL DEFAULT '[]',
  source       TEXT,
  UNIQUE (project, section, title_norm)
);

INSERT INTO queue_items_new
  (id, project, section, priority, position, title, title_norm, body, closed_at, close_reason,
   source_file, source_line, body_hash, created_at, updated_at, blocked_by, source)
  SELECT id, project, section, priority, position, title, title_norm, body, closed_at, close_reason,
         source_file, source_line, body_hash, created_at, updated_at, blocked_by, source
    FROM queue_items;

DROP TABLE queue_items;
ALTER TABLE queue_items_new RENAME TO queue_items;

CREATE INDEX idx_queue_items_by_project      ON queue_items(project);
CREATE INDEX idx_queue_items_open_by_prio    ON queue_items(priority DESC, project, section, position)
                                              WHERE section != 'archive';
CREATE INDEX idx_queue_items_archive_by_date ON queue_items(closed_at DESC, project)
                                              WHERE section = 'archive';
CREATE INDEX idx_queue_items_by_priority     ON queue_items(priority, project, section, position)
                                              WHERE section != 'archive';
CREATE INDEX idx_queue_items_source          ON queue_items(project, source);

UPDATE meta SET value = '35' WHERE key = 'schema_version';
