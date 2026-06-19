-- 0014 — normalize fossil full-timestamp `created` values to date-only.
--
-- `created`/`updated` are date-typed (YYYY-MM-DD) by the note-format
-- convention, but early imports stored some `created` as full ISO timestamps
-- (e.g. `2026-04-29T02:39:23.977Z`), and `created` is preserved (never
-- overwritten) on upsert — so those never reconciled to the file's date. The
-- reindex churn that caused (re-importing unchanged records on every restart,
-- bumping modified_at) was fixed in src/importer/import-file.ts by comparing
-- created/updated at date granularity; this migration also cleans the stored
-- data so the API serves `created` consistently as a date.
--
-- `updated` needs no fix here: it's refreshed from the file's frontmatter on
-- every import (it's in the upsert's DO UPDATE SET), so it self-heals to the
-- file's date-only value.
--
-- Idempotent: only rows whose `created` is longer than a bare `YYYY-MM-DD`
-- (10 chars) are touched, and substr(...,1,10) of a date-only value is itself.
-- A plain UPDATE (not an upsert) — it does not stamp `modified_at`.

UPDATE records SET created = substr(created, 1, 10) WHERE length(created) > 10;

UPDATE meta SET value = '14' WHERE key = 'schema_version';
