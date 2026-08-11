-- 0017 — repo-lease registry + event log (agent-coordination design, D21/D23).
--
-- Coordination state is ephemeral by design: the server clears both tables on
-- start (durability lives in the filesystem; a lease that dies with a restart
-- is re-claimed in a fair race). The tables still live in the schema so the
-- closed enums are CHECK-enforced like every other enum in the DB.
--
-- Structural invariants per D23: a human holder has no priority and no expiry
-- (humans don't renew; "busy human" is normal); an agent holder has both.

CREATE TABLE leases (
  resource     TEXT PRIMARY KEY,
  holder       TEXT NOT NULL,
  holder_kind  TEXT NOT NULL DEFAULT 'agent' CHECK (holder_kind IN ('agent', 'human')),
  priority     TEXT CHECK (priority IN ('cwd', 'side') OR priority IS NULL),
  attestation  TEXT,
  claimed_at   TEXT NOT NULL,
  renewed_at   TEXT NOT NULL,
  expires_at   TEXT,
  CHECK ((holder_kind = 'human') = (priority IS NULL)),
  CHECK ((holder_kind = 'human') = (expires_at IS NULL))
);

CREATE TABLE lease_events (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  at       TEXT NOT NULL,
  resource TEXT NOT NULL,
  event    TEXT NOT NULL CHECK (event IN (
    'claimed', 'renewed', 'preempted', 'expired', 'released', 'transferred'
  )),
  holder   TEXT,
  detail   TEXT
);

CREATE INDEX idx_lease_events_resource ON lease_events(resource, seq);

UPDATE meta SET value = '17' WHERE key = 'schema_version';
