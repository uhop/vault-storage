-- 0009 — auto-resolve pending suggestions when their subject record is deleted.
--
-- Bug discovered 2026-05-14 via the new `/ui/archive-review.html` page: the
-- user clicked "Delete file" on an archive_candidate, the file was removed,
-- and the suggestion stayed `pending` with a now-orphaned `subject_id`.
-- The 0007 records_after_delete trigger only cascaded to `record_vec` /
-- `record_doc_vec` — the suggestions table was never wired into the cascade.
-- Generalizes beyond archive_candidate: any kind whose `subject_id` points
-- at the deleted record (edge_type, duplicate, compaction_candidate,
-- contradiction_candidate, archive_candidate, etc.) was affected.
--
-- The `suggestions` table intentionally has no FK on `subject_id` — the
-- column is nullable for system-level suggestions (e.g.,
-- inefficiency_detected). So FK-driven cascade isn't an option; this is a
-- supplemental AFTER DELETE trigger paired with `records_after_delete`.
--
-- Resolution semantics:
--   - status      → 'accepted'        (deletion is a stronger action than
--                                       the suggestion proposed; the user
--                                       agreed by removing the record)
--   - resolved_by → 'record-deleted'  (distinct marker so the audit trail
--                                       distinguishes cascade resolution
--                                       from user-driven /accept calls
--                                       and from fm-override auto-accepts)
--
-- Idempotent against re-runs: the `status = 'pending'` predicate excludes
-- already-resolved rows so a later DELETE of a record whose suggestions
-- were already triaged is a no-op on this trigger.

CREATE TRIGGER IF NOT EXISTS records_after_delete_resolve_suggestions
AFTER DELETE ON records
BEGIN
  UPDATE suggestions
     SET status      = 'accepted',
         resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         resolved_by = 'record-deleted'
   WHERE subject_id = OLD.record_id
     AND status     = 'pending';
END;

UPDATE meta SET value = '9' WHERE key = 'schema_version';
