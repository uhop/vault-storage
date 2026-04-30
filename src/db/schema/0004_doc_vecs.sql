-- 0004 — record-level (whole-document) embeddings.
--
-- Complements `record_vec` (chunked) for whole-document operations such as
-- duplicate detection, clustering, and centroid queries. Mean-pooled and
-- L2-renormalized from the per-record chunk embeddings; one row per record.
--
-- `record_vec` is kept as the source of truth for chunk-level retrieval
-- (`/sections/{id}/similar`) — chunk-min preserves passage-level signal that
-- mean-pooling drowns. The two indices serve two questions: chunks for
-- "find passages near my query", record-doc for "find documents like this
-- one as a whole".

CREATE VIRTUAL TABLE record_doc_vec USING vec0(
  record_id     TEXT PRIMARY KEY,
  +content_hash TEXT,
  embedding     FLOAT[384]
);

UPDATE meta SET value = '4' WHERE key = 'schema_version';
