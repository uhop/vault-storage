-- 0037 — the index of external links (D112, 2026-09-30): one row per mention
-- of an outside object in a note, keyed as a queue item's `source:` spells the
-- object, so a ticket, a design, or an error lists the notes that mention it;
-- and each project's declared `github` tracker from its queue.md frontmatter,
-- by which a lookup resolves a bare `#n` without reading the disk. Both are
-- written by `importFile` and go with their record. This migration forces the
-- full import that fills them.

CREATE TABLE external_links (
  record_id TEXT NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
  key       TEXT NOT NULL,             -- `github o/r#5`, `figma <file>`, `url <normalized>`, or a bare `#5`
  raw       TEXT NOT NULL,             -- the text as written, to find the queue item that holds it
  url       TEXT,                      -- the URL as written; NULL for a reference or a `source:` line
  project   TEXT,                      -- the note's project, by which a bare `#5` resolves
  PRIMARY KEY (record_id, key, raw)
);
CREATE INDEX idx_external_links_key ON external_links(key);

CREATE TABLE project_github (
  record_id TEXT PRIMARY KEY REFERENCES records(record_id) ON DELETE CASCADE,
  project   TEXT NOT NULL,
  repo      TEXT NOT NULL              -- lowercased `owner/name`
);

UPDATE meta SET value = '37' WHERE key = 'schema_version';
