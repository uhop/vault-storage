-- 0024 — `agent.summary` gets its own vector (D45). Through 0023 the chunker
-- prefixed the summary to every chunk: a summary refresh re-embedded the whole
-- note, and on croc's data (2026-09-15) the prefix took 708 of the embedder's
-- 1,500 characters on the average chunk, so 27% of body text was never
-- embedded. A record is current when its chunks, and its summary vector if it
-- has a summary, carry its content_hash. Summarized records have no row here
-- yet, so the embed pass re-chunks them without the prefix, in rounds.
--
-- The hashes live in a regular table, as 0010 moved chunk metadata out of
-- vec0: the embed pass checks every summarized record per round, and that
-- query took 73 ms against vec0 and 7 ms against this table on croc's data.
-- migrate:no-reindex

CREATE TABLE record_summaries (
  record_id    TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  text_hash    TEXT
);

CREATE VIRTUAL TABLE record_summary_vec USING vec0(
  record_id TEXT PRIMARY KEY,
  embedding FLOAT[384]
);

DROP TRIGGER IF EXISTS records_after_delete;
CREATE TRIGGER records_after_delete
AFTER DELETE ON records
BEGIN
  DELETE FROM record_vec WHERE chunk_id IN (
    SELECT chunk_id FROM chunks WHERE record_id = OLD.record_id
  );
  DELETE FROM chunks WHERE record_id = OLD.record_id;
  DELETE FROM record_doc_vec WHERE record_id = OLD.record_id;
  DELETE FROM record_summary_vec WHERE record_id = OLD.record_id;
  DELETE FROM record_summaries WHERE record_id = OLD.record_id;
END;

UPDATE meta SET value = '24' WHERE key = 'schema_version';
