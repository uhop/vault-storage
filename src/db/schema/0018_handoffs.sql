-- 0018 — handoff queue + event log (agent-coordination design, leg 2).
--
-- Handoffs are durable in the spool (handoff/<project>/<status>/<id>.md —
-- files are truth, status is the directory); these tables are the derived
-- index, cleared and rebuilt by scan on every server start. Enums are
-- CHECK-enforced like every other enum in the DB.
--
-- Structural invariants: claim columns travel together and exist exactly
-- while status = 'claimed'; a ref is a (type, value) pair or absent; result
-- exists only on a terminal resolution (done/rejected — a `returned` critique
-- rides notes, not result).

CREATE TABLE handoffs (
  id              TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  project         TEXT NOT NULL,
  to_role         TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('review-branch', 'apply-patch', 'answer-question', 'run-check')),
  ref_type        TEXT CHECK (ref_type IN ('worktree', 'branch', 'spool') OR ref_type IS NULL),
  ref_value       TEXT,
  from_host       TEXT NOT NULL,
  from_session    TEXT NOT NULL,
  from_repo       TEXT,
  body            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'done', 'rejected', 'returned')),
  created         TEXT NOT NULL,
  updated         TEXT NOT NULL,
  claimed_by      TEXT,
  claimed_at      TEXT,
  claim_expires   TEXT,
  result          TEXT,
  notes           TEXT NOT NULL DEFAULT '[]',
  CHECK ((ref_type IS NULL) = (ref_value IS NULL)),
  CHECK ((status = 'claimed') = (claimed_by IS NOT NULL)),
  CHECK ((claimed_by IS NULL) = (claimed_at IS NULL)),
  CHECK ((claimed_by IS NULL) = (claim_expires IS NULL)),
  CHECK (result IS NULL OR status IN ('done', 'rejected'))
);

CREATE INDEX idx_handoffs_role ON handoffs(to_role, status);
CREATE INDEX idx_handoffs_project ON handoffs(project, status);

CREATE TABLE handoff_events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  handoff_id TEXT NOT NULL,
  event      TEXT NOT NULL CHECK (event IN (
    'created', 'claimed', 'claim_expired', 'done', 'rejected', 'returned', 'resubmitted', 'note'
  )),
  actor      TEXT,
  detail     TEXT
);

CREATE INDEX idx_handoff_events_id ON handoff_events(handoff_id, seq);

UPDATE meta SET value = '18' WHERE key = 'schema_version';
