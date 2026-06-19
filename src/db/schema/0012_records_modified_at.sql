-- 0012 — records.modified_at: precise write timestamp captured at import.
--
-- `updated` mirrors the frontmatter `updated:` field, which is date-only
-- (YYYY-MM-DD). Recency sort / the dashboard "Recently updated" list can't
-- distinguish edits within a day, and a date parsed as midnight UTC misreports
-- same-day work as "1d ago" once the clock crosses the next UTC midnight.
-- `modified_at` is a full ISO-8601 timestamp the records upsert
-- (src/records/repository.ts) stamps on every insert/update, giving true
-- sub-day ordering.
--
-- Forward-only by design: nullable, NOT backfilled. Existing rows keep NULL
-- until their next import; consumers fall back to `updated` via
-- COALESCE(modified_at, updated), so recency degrades gracefully to date
-- granularity for untouched notes (no retroactive git-time backfill).

ALTER TABLE records ADD COLUMN modified_at TEXT;

UPDATE meta SET value = '12' WHERE key = 'schema_version';
