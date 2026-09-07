-- 0021 — handoffs declare what they touch and carry hash-bound verifications
-- (D34, 2026-09-06). `touches` is the submitter's declared operations
-- ([{kind, key, operation}]), `verifications` the append-only gate records
-- ([{check, sha, exit, at, by}]), `base_sha` the `base-commit:` trailer parsed
-- from a format-patch artifact, against which a verification's sha is judged
-- stale. Files in the spool stay the truth; these columns index them.
--
-- `handoff_events` gains the 'verified' event: the CHECK is inside the table
-- definition, so the table is recreated (its rows are a transcript that is
-- cleared on every server start anyway, as in 0019).

ALTER TABLE handoffs ADD COLUMN touches TEXT NOT NULL DEFAULT '[]';
ALTER TABLE handoffs ADD COLUMN verifications TEXT NOT NULL DEFAULT '[]';
ALTER TABLE handoffs ADD COLUMN base_sha TEXT;

DROP TABLE handoff_events;

CREATE TABLE handoff_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  event      TEXT NOT NULL CHECK (event IN (
    'created', 'claimed', 'claim_expired', 'done', 'rejected', 'returned',
    'resubmitted', 'note', 'artifact', 'verified'
  )),
  actor      TEXT,
  detail     TEXT
);

CREATE INDEX idx_handoff_events_id ON handoff_events(handoff_id, seq);

UPDATE meta SET value = '21' WHERE key = 'schema_version';
