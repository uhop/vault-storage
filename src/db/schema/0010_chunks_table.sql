-- 0010 — chunk metadata moves to a regular `chunks` companion table.
--
-- record_vec's `+record_id` / `+chunk_index` / `+content_hash` aux columns
-- are unindexed: vec0 supports them only as row payload, so every
-- `WHERE record_id = ?` point lookup was a full vec0 scan (~20ms at 6K
-- chunks; the 2026-05 lint incident was a ~7s correlated variant). The
-- workarounds (pre-materialized CTE anti-joins in lint/cleanup-lint,
-- getAllChunks bulk loads) treated the symptom. The fix is structural:
-- chunk metadata lives in a regular table with a B-tree index on
-- record_id; record_vec keeps only `chunk_id + embedding`. Point lookups
-- become indexed joins on chunks, with vec0 touched only by PK.
--
-- Aux values are copied from the existing record_vec rows — embeddings are
-- preserved verbatim through a staging table, so no re-embedding happens.
-- (vec0 virtual tables can't ALTER COLUMN; drop + recreate is the only
-- path to the narrower shape.)
--
-- The 0007 records_after_delete trigger referenced record_vec.record_id,
-- which no longer exists — it is rebuilt here. Inside the trigger, the
-- record_vec delete must precede the chunks delete: vec rows are located
-- through chunks, so reversing the order would leak vec rows.

CREATE TABLE chunks (
  chunk_id     TEXT PRIMARY KEY,
  record_id    TEXT NOT NULL,
  chunk_index  INTEGER NOT NULL,
  content_hash TEXT NOT NULL
);
CREATE INDEX idx_chunks_record ON chunks(record_id);

INSERT INTO chunks (chunk_id, record_id, chunk_index, content_hash)
SELECT chunk_id, record_id, chunk_index, content_hash FROM record_vec;

CREATE TABLE record_vec_stage (
  chunk_id  TEXT PRIMARY KEY,
  embedding BLOB NOT NULL
);
INSERT INTO record_vec_stage (chunk_id, embedding)
SELECT chunk_id, embedding FROM record_vec;

DROP TABLE record_vec;

CREATE VIRTUAL TABLE record_vec USING vec0(
  chunk_id  TEXT PRIMARY KEY,
  embedding FLOAT[384]
);

INSERT INTO record_vec (chunk_id, embedding)
SELECT chunk_id, embedding FROM record_vec_stage;

DROP TABLE record_vec_stage;

DROP TRIGGER IF EXISTS records_after_delete;
CREATE TRIGGER records_after_delete
AFTER DELETE ON records
BEGIN
  DELETE FROM record_vec WHERE chunk_id IN (
    SELECT chunk_id FROM chunks WHERE record_id = OLD.record_id
  );
  DELETE FROM chunks WHERE record_id = OLD.record_id;
  DELETE FROM record_doc_vec WHERE record_id = OLD.record_id;
END;

UPDATE meta SET value = '10' WHERE key = 'schema_version';
