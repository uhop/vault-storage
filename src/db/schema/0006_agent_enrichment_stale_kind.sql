-- 0006 — extend `suggestions.kind` CHECK to include `agent_enrichment_stale`.
--
-- Filed by the importer when a record's frontmatter has both `agent.summary`
-- and `agent.derived_from_hash` and the recorded hash no longer matches the
-- current body's hash — the LLM derived the summary against an older body,
-- so the enrichment may be stale.  Resolution path is "rerun enrich-all on
-- this record"; auto-resolves on the next import where hash + body match.
--
-- SQLite can't ALTER a CHECK constraint in place, so we recreate the table.
-- Cheap on the live deployment (~1.4K rows).  Wrapped in the migration's
-- existing transaction by `runMigrations`.

CREATE TABLE suggestions_v6 (
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
    'pending', 'accepted', 'rejected'
  )),
  created     TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);

INSERT INTO suggestions_v6 (id, kind, subject_id, payload, status, created, resolved_at, resolved_by)
SELECT id, kind, subject_id, payload, status, created, resolved_at, resolved_by FROM suggestions;

DROP TABLE suggestions;
ALTER TABLE suggestions_v6 RENAME TO suggestions;

CREATE INDEX idx_suggestions_status      ON suggestions(status, created);
CREATE INDEX idx_suggestions_kind_status ON suggestions(kind, status);

UPDATE meta SET value = '6' WHERE key = 'schema_version';
