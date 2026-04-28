-- vault-storage v1 schema.
-- Sources of truth (in the design vault):
--   projects/vault-storage/design/backend-comparison.md  (table sketch)
--   projects/vault-storage/design/closed-enums.md        (status / type / suggestion enums + tags taxonomy)
--   projects/vault-storage/design/edge-taxonomy.md       (10 edge types)
--   projects/vault-storage/design/embedding-model.md     (vector dim = 384)

-- ---------------------------------------------------------------------------
-- records: one row per markdown piece (file or atomized section).
-- ---------------------------------------------------------------------------

CREATE TABLE records (
  record_id       TEXT PRIMARY KEY,                                 -- UUIDv7
  file_path       TEXT NOT NULL UNIQUE,                             -- vault-relative path
  parent_path     TEXT,                                             -- folder for atomized pieces; NULL for standalone
  sequence_key    INTEGER,                                          -- ordering hint within parent_path
  type            TEXT NOT NULL CHECK (type IN (
    'idea', 'design', 'plan', 'queue-item', 'research', 'bug-report', 'project',
    'permanent', 'log', 'query', 'fleeting', 'state', 'meta', 'index'
  )),
  body            TEXT NOT NULL,
  content_hash    TEXT NOT NULL,                                    -- sha256 of normalized body
  created         TEXT NOT NULL,                                    -- ISO 8601
  updated         TEXT NOT NULL,
  last_referenced TEXT,
  decay_score     REAL NOT NULL DEFAULT 1.0,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'draft', 'done', 'superseded', 'archived'
  )),
  priority        INTEGER NOT NULL DEFAULT 0,                       -- higher = more urgent; open-ended
  archived_at     TEXT
);

CREATE INDEX idx_records_parent_path ON records(parent_path, sequence_key);
CREATE INDEX idx_records_status_decay ON records(status, decay_score);
CREATE INDEX idx_records_priority    ON records(priority DESC, created) WHERE priority != 0;
CREATE INDEX idx_records_type        ON records(type, status);

-- ---------------------------------------------------------------------------
-- record_vec: BGE-small-en-v1.5 embeddings (384-dim float32).
-- Virtual tables can't carry FK constraints; record_vec rows are kept in sync
-- by the application layer (insert / delete on records mirrors here).
--
-- The `+content_hash` auxiliary column tracks the body hash that produced
-- this vector. The embed pass joins record_vec ↔ records and re-embeds when
-- record_vec.content_hash != records.content_hash (i.e., body has changed
-- since this vector was computed).
-- ---------------------------------------------------------------------------

CREATE VIRTUAL TABLE record_vec USING vec0(
  record_id     TEXT PRIMARY KEY,
  +content_hash TEXT,
  embedding     FLOAT[384]
);

-- ---------------------------------------------------------------------------
-- edges: typed relationships between records.
-- ---------------------------------------------------------------------------

CREATE TABLE edges (
  from_id  TEXT NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
  to_id    TEXT NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
  type     TEXT NOT NULL CHECK (type IN (
    'supersedes', 'revises', 'derived-from', 'caused-by', 'fixed-by',
    'rejected-because', 'cites', 'applies-to', 'contradicts', 'related-to'
  )),
  weight   REAL NOT NULL DEFAULT 1.0,
  note     TEXT,
  created  TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id, type)
);
CREATE INDEX idx_edges_to ON edges(to_id, type);

-- ---------------------------------------------------------------------------
-- tags taxonomy: managed closed list with synonym aliases.
-- ---------------------------------------------------------------------------

CREATE TABLE tags_taxonomy (
  tag         TEXT PRIMARY KEY
              CHECK (tag = lower(tag) AND length(tag) > 0
                AND tag GLOB '[a-z0-9]*' AND tag NOT GLOB '*[^a-z0-9-]*'),
  description TEXT,
  added       TEXT NOT NULL
);

CREATE TABLE tag_aliases (
  alias     TEXT PRIMARY KEY CHECK (alias = lower(alias)),
  canonical TEXT NOT NULL REFERENCES tags_taxonomy(tag) ON UPDATE CASCADE
);

CREATE TABLE tags (
  record_id TEXT NOT NULL REFERENCES records(record_id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (record_id, tag)
);
CREATE INDEX idx_tags_tag ON tags(tag);

-- Reject tags missing from the taxonomy.
-- (The API layer rewrites known aliases via tag_aliases before insert.)
CREATE TRIGGER enforce_tag_taxonomy
BEFORE INSERT ON tags
FOR EACH ROW
WHEN NOT EXISTS (SELECT 1 FROM tags_taxonomy WHERE tag = NEW.tag)
BEGIN
  SELECT RAISE(ABORT, 'unknown tag; add to tags_taxonomy first or file a new_tag suggestion');
END;

-- ---------------------------------------------------------------------------
-- suggestions: the agent review queue.
-- ---------------------------------------------------------------------------

CREATE TABLE suggestions (
  id          TEXT PRIMARY KEY,                                     -- UUIDv7
  kind        TEXT NOT NULL CHECK (kind IN (
    'edge_type', 'duplicate', 'archive_candidate', 'merge_candidate',
    'compaction_candidate', 'contradiction_candidate', 'tag_suggestion',
    'new_tag', 'inefficiency_detected', 'infrastructure_upgrade',
    'frontmatter_inference_ambiguous'
  )),
  subject_id  TEXT,                                                 -- records.record_id (nullable for system-level)
  payload     TEXT NOT NULL,                                        -- JSON
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'accepted', 'rejected'
  )),
  created     TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT
);
CREATE INDEX idx_suggestions_status      ON suggestions(status, created);
CREATE INDEX idx_suggestions_kind_status ON suggestions(kind, status);

-- Mark schema as v1.
UPDATE meta SET value = '1' WHERE key = 'schema_version';
