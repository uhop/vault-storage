-- 0031 — the edge vocabulary trimmed to seven types (D94, 2026-09-28): caused-by,
-- fixed-by, and rejected-because become cites, the declared name kept in the
-- edge's note. A pair that already carries a cites edge loses the legacy row
-- instead. The importer normalizes the same names the same way from now on.
-- migrate:no-reindex

DELETE FROM edges
 WHERE type IN ('caused-by', 'fixed-by', 'rejected-because')
   AND EXISTS (
     SELECT 1 FROM edges c
      WHERE c.from_id = edges.from_id AND c.to_id = edges.to_id AND c.type = 'cites'
   );

UPDATE edges
   SET note = CASE
                WHEN note IS NULL OR note = '' THEN 'declared as ' || type
                ELSE note || '; declared as ' || type
              END,
       type = 'cites'
 WHERE type IN ('caused-by', 'fixed-by', 'rejected-because');

UPDATE meta SET value = '31' WHERE key = 'schema_version';
