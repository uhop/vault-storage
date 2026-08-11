-- 0019 — handoff_events gains the `artifact` event (agent-coordination leg 3).
--
-- Attaching the transported work is not a status transition, but it is a real
-- entry in the coordination transcript ("who attached what, and how big"), so
-- it needs its own event rather than riding `note`.
--
-- SQLite cannot widen a CHECK in place, and this table is cleared on every
-- server start by design (D21) — there is no data to preserve, so a drop and
-- recreate is the cheapest correct migration rather than a table rebuild.

DROP TABLE handoff_events;

CREATE TABLE handoff_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  event      TEXT NOT NULL CHECK (event IN (
    'created', 'claimed', 'claim_expired', 'done', 'rejected', 'returned',
    'resubmitted', 'note', 'artifact'
  )),
  actor      TEXT,
  detail     TEXT
);

CREATE INDEX idx_handoff_events_id ON handoff_events(handoff_id, seq);

UPDATE meta SET value = '19' WHERE key = 'schema_version';
