-- 0016 — queue_items.blocked_by: raw `blocked-by:` refs parsed from the item
-- body, as a JSON array of strings ('[]' when none). Refs are normalized-title
-- substrings resolved at QUERY time (src/queue/ready.ts), never stored as ids —
-- the table's DELETE+INSERT identity model would strand resolved ids on every
-- title edit or section move. Ready/blocked semantics and the resolution
-- order live in projects/vault-storage/design/queue-items-table.md (2026-07-23
-- addendum); the markdown marker shape is in topics/project-queue-convention.

ALTER TABLE queue_items ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]';

UPDATE meta SET value = '16' WHERE key = 'schema_version';
