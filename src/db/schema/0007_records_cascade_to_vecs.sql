-- 0007 — mirror records-delete to record_vec and record_doc_vec.
--
-- Bug discovered 2026-05-01 via /system/lint reporting 137 orphan
-- embeddings: the four call sites that invoke records.delete() (the
-- watcher's missing-file path, DELETE /vault/{path}, and
-- incremental-reindex's delete + rename branches) didn't clean up the
-- chunk-level record_vec or document-level record_doc_vec rows. The
-- 137 production orphans correlate with the 2026-04-28 21:39 CDT
-- atomization-import deploy, where the splitter replaced parent files
-- with their per-piece atomized children — each parent's embeddings
-- stayed in record_vec after the parent's records row was deleted.
--
-- An AFTER DELETE trigger on the regular `records` table fires on
-- every records-delete path, including raw SQL or any future call
-- site. The body deletes from both virtual vec0 tables (sqlite-vec
-- accepts DELETE on its backing). This is structural: callers can no
-- longer leak orphans by forgetting to mirror.
--
-- Existing orphans aren't cleaned by this migration — they're the job
-- of /maintenance/cleanup-lint, which already handles record_vec and
-- (after the lint extension that ships alongside this migration)
-- record_doc_vec.

CREATE TRIGGER IF NOT EXISTS records_after_delete
AFTER DELETE ON records
BEGIN
  DELETE FROM record_vec     WHERE record_id = OLD.record_id;
  DELETE FROM record_doc_vec WHERE record_id = OLD.record_id;
END;

UPDATE meta SET value = '7' WHERE key = 'schema_version';
