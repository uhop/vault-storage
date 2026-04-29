-- Add a `title` column to records. Title lives in YAML frontmatter (user-authored)
-- but isn't otherwise present in the records table; surfacing it here lets the
-- API return it without re-parsing body frontmatter on every read.
--
-- Nullable: a record may legitimately have no title (the body is the content).
-- Backfill from existing records' frontmatter is handled at re-import time;
-- this migration just adds the column.

ALTER TABLE records ADD COLUMN title TEXT;

UPDATE meta SET value = '2' WHERE key = 'schema_version';
