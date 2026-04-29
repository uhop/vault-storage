-- Per-file baseline for incremental Obsidian → vault-data sync. Stores the
-- hash of the content last written by a sync, so the next sync can detect
-- whether the target has been edited locally since (the local-edit guard
-- per A.5 / [[projects/vault-storage/design/api-surface]]).
--
-- Three-way merge: source (Obsidian, transformed), target (vault-data on
-- disk), baseline (this table). If target's current hash diverges from the
-- recorded baseline, a local edit happened and the sync skips the file.

CREATE TABLE sync_baseline (
  file_path     TEXT PRIMARY KEY,
  content_hash  TEXT NOT NULL,
  synced_at     TEXT NOT NULL
);

UPDATE meta SET value = '3' WHERE key = 'schema_version';
