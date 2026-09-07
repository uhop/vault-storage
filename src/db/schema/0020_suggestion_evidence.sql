-- 0020 — backfill `payload.evidence` {source, asserted} on suggestions filed
-- before the filer stamped it (D33, 2026-09-06). Assigned by kind, which is
-- the producer for every indexer- and scan-filed row; a hand-filed row of an
-- indexer kind is stamped like the indexer's, since the row cannot tell.
-- Idempotent: only rows without an evidence key are touched.

UPDATE suggestions
   SET payload = json_set(payload, '$.evidence', json('{"source":"structural","asserted":true}'))
 WHERE json_valid(payload) AND json_extract(payload, '$.evidence') IS NULL
   AND kind IN ('edge_type', 'new_tag', 'agent_enrichment_stale');

UPDATE suggestions
   SET payload = json_set(payload, '$.evidence', json('{"source":"metric","asserted":true}'))
 WHERE json_valid(payload) AND json_extract(payload, '$.evidence') IS NULL
   AND kind IN ('compaction_candidate', 'archive_candidate', 'inefficiency_detected', 'infrastructure_upgrade');

UPDATE suggestions
   SET payload = json_set(payload, '$.evidence', json('{"source":"vector","asserted":false}'))
 WHERE json_valid(payload) AND json_extract(payload, '$.evidence') IS NULL
   AND kind = 'duplicate';

UPDATE suggestions
   SET payload = json_set(payload, '$.evidence', json('{"source":"agent","asserted":false}'))
 WHERE json_valid(payload) AND json_extract(payload, '$.evidence') IS NULL
   AND kind IN ('tag_suggestion', 'merge_candidate', 'contradiction_candidate', 'frontmatter_inference_ambiguous');

UPDATE meta SET value = '20' WHERE key = 'schema_version';
