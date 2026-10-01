-- 0040 — record ids read from the vault's repository into a fresh database
-- (D123): `seedVaultState` fills the table from `.vault-storage-state/
-- records.jsonl` before the first import, `importFile` takes a path's id when it
-- inserts the path, and the rows left after the startup reindex are dropped.
-- migrate:no-reindex

CREATE TABLE seeded_record_ids (
  file_path TEXT PRIMARY KEY,
  record_id TEXT NOT NULL UNIQUE
);

UPDATE meta SET value = '40' WHERE key = 'schema_version';
