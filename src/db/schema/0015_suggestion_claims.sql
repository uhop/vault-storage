-- 0015 — suggestion claims: batch claim/lease for concurrent triage sessions.
--
-- New status 'claimed' = unresolved-but-reserved. `POST /suggestions/claim`
-- atomically flips a batch pending → claimed for a holder with a TTL;
-- expired claims lazily revert to pending (`revertExpiredClaims` at the
-- suggestion read/mutate entry points — no background job). Resolving a
-- live-claimed row requires `resolved_by = claimed_by`.
--
-- SQLite can't ALTER a CHECK constraint in place, so we recreate the table
-- (0006 is the template). The 0009 cascade trigger is recreated with the
-- claimed predicate — deleting a record settles its claimed suggestions too.

DROP TRIGGER IF EXISTS records_after_delete_resolve_suggestions;

CREATE TABLE suggestions_v15 (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN (
    'edge_type', 'duplicate', 'archive_candidate', 'merge_candidate',
    'compaction_candidate', 'contradiction_candidate', 'tag_suggestion',
    'new_tag', 'inefficiency_detected', 'infrastructure_upgrade',
    'frontmatter_inference_ambiguous', 'agent_enrichment_stale'
  )),
  subject_id  TEXT,
  payload     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'claimed', 'accepted', 'rejected'
  )),
  created       TEXT NOT NULL,
  resolved_at   TEXT,
  resolved_by   TEXT,
  claimed_by    TEXT,
  claimed_at    TEXT,
  claim_expires TEXT
);

INSERT INTO suggestions_v15 (id, kind, subject_id, payload, status, created, resolved_at, resolved_by)
SELECT id, kind, subject_id, payload, status, created, resolved_at, resolved_by FROM suggestions;

DROP TABLE suggestions;
ALTER TABLE suggestions_v15 RENAME TO suggestions;

CREATE INDEX idx_suggestions_status      ON suggestions(status, created);
CREATE INDEX idx_suggestions_kind_status ON suggestions(kind, status);

CREATE TRIGGER records_after_delete_resolve_suggestions
AFTER DELETE ON records
BEGIN
  UPDATE suggestions
     SET status        = 'accepted',
         resolved_at   = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
         resolved_by   = 'record-deleted',
         claimed_by    = NULL,
         claimed_at    = NULL,
         claim_expires = NULL
   WHERE subject_id = OLD.record_id
     AND status IN ('pending', 'claimed');
END;

UPDATE meta SET value = '15' WHERE key = 'schema_version';
