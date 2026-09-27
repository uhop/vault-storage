-- 0026 — claim tokens (D67, 2026-09-27). A claim on a lease, a handoff, or a
-- batch of suggestions issues a random token, returned only to the claimer;
-- renew, release, transfer, resolve, and reopen present it. The holder name
-- stays as a label: two claims under one name no longer share a fence.
--
-- Leases are cleared on start and handoffs are rebuilt from the spool, so
-- only suggestions carry live claims across this migration. They have no
-- token to present, so they revert to pending — the same state a lapsed claim
-- reaches, at most one TTL early.
-- migrate:no-reindex

ALTER TABLE leases ADD COLUMN claim_token TEXT;
ALTER TABLE handoffs ADD COLUMN claim_token TEXT;
ALTER TABLE suggestions ADD COLUMN claim_token TEXT;

UPDATE suggestions
   SET status = 'pending', claimed_by = NULL, claimed_at = NULL, claim_expires = NULL
 WHERE status = 'claimed';

DROP TRIGGER IF EXISTS records_after_delete_resolve_suggestions;

CREATE TRIGGER records_after_delete_resolve_suggestions
AFTER DELETE ON records
BEGIN
  UPDATE suggestions
     SET status        = 'accepted',
         resolved_at   = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         resolved_by   = 'record-deleted',
         claimed_by    = NULL,
         claimed_at    = NULL,
         claim_expires = NULL,
         claim_token   = NULL
   WHERE subject_id = OLD.record_id
     AND status IN ('pending', 'claimed');
END;

UPDATE meta SET value = '26' WHERE key = 'schema_version';
