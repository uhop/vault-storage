-- 0023 — per-chunk text hash, so a re-embed reuses the vectors of chunks whose
-- text did not change. An append to a 981-chunk note changes one chunk and a
-- mid-paragraph edit two (measured 2026-09-14), while every edit re-embedded the
-- whole note (160 s on nuke for that note). NULL until the chunk is embedded
-- again or `backfillChunkTextHashes` fills it.
-- migrate:no-reindex

ALTER TABLE chunks ADD COLUMN text_hash TEXT;

UPDATE meta SET value = '23' WHERE key = 'schema_version';
