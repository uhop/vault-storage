-- 0034 — queue_items.source: the `source:` marker parsed from an item's body
-- (D107, 2026-09-29), the outside ticket the item mirrors, as written and
-- whitespace-collapsed: `github uhop/vault-storage#15`, `linear ENG-123`.
-- An insert that carries the same source updates the open item that has it
-- instead of filing a second. Derived on import like every other column here.

ALTER TABLE queue_items ADD COLUMN source TEXT;
CREATE INDEX IF NOT EXISTS idx_queue_items_source ON queue_items(project, source);

UPDATE meta SET value = '34' WHERE key = 'schema_version';
