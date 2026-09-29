-- 0030 — one vector per taxonomy tag, embedded from its name and description,
-- for the nearest-tag lookup (POST /tags/nearest). The 0024 layout: the text
-- hash in a regular table, the vector in vec0, refreshed when the hash moves.
-- A taxonomy delete takes the vector with it, since vec0 joins nothing.
-- migrate:no-reindex

CREATE TABLE IF NOT EXISTS tag_vec_meta (
  tag       TEXT PRIMARY KEY,
  text_hash TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS tag_vec USING vec0(
  tag TEXT PRIMARY KEY,
  embedding FLOAT[384]
);

CREATE TRIGGER IF NOT EXISTS tags_taxonomy_after_delete
AFTER DELETE ON tags_taxonomy
BEGIN
  DELETE FROM tag_vec WHERE tag = OLD.tag;
  DELETE FROM tag_vec_meta WHERE tag = OLD.tag;
END;

UPDATE meta SET value = '30' WHERE key = 'schema_version';
