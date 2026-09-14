-- 0022 — index the identity lookups the importer runs per file and per link.
-- `SuggestionFiler` matches payload keys with `json_extract`, and the only
-- indexes were on (kind, status), so each existence check scanned every row of
-- its kind: 7,739 edge_type rows per body link on croc (2026-09-14), which made
-- a full reindex quadratic and taxed every write's scoped edge rebuild. The
-- expressions must stay byte-identical to `column()` in
-- src/importer/file-suggestions.ts, or the planner cannot use them.

CREATE INDEX idx_suggestions_edge_type_from ON suggestions(json_extract(payload, '$.from_record'))
  WHERE kind = 'edge_type';

CREATE INDEX idx_suggestions_new_tag_identity
  ON suggestions(json_extract(payload, '$.tag'), json_extract(payload, '$.record_id'))
  WHERE kind = 'new_tag';

-- record_id first: the per-file pending lookup matches on it alone.
CREATE INDEX idx_suggestions_tag_suggestion_identity
  ON suggestions(json_extract(payload, '$.record_id'), json_extract(payload, '$.tag'))
  WHERE kind = 'tag_suggestion';

UPDATE meta SET value = '22' WHERE key = 'schema_version';
