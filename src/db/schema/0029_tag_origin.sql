-- 0029 — where each taxonomy tag came from (D77).
--
-- `seeded`: the 2026-04-29 migration's canonical list; `minted`: added
-- automatically, by a new_tag triage or any other API call that does not
-- say otherwise; `manual`: created on purpose, which the garbage collection
-- keeps at zero records. The backfill has no evidence of a manual tag.
--
-- migrate:no-reindex

ALTER TABLE tags_taxonomy ADD COLUMN origin TEXT NOT NULL DEFAULT 'minted'
  CHECK (origin IN ('manual', 'seeded', 'minted'));

UPDATE tags_taxonomy SET origin = 'seeded' WHERE added LIKE '2026-04-29%';

UPDATE meta SET value = '29' WHERE key = 'schema_version';
