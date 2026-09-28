-- 0028 — settle pending edge_type suggestions as default-cites (D76).
--
-- From D76 the edge pass files a default-cites review row already rejected
-- with resolved_by 'default-cites'; this settles the rows filed pending
-- before it, the same way. Claimed rows are left to their holder.
--
-- migrate:no-reindex

UPDATE suggestions
   SET status = 'rejected',
       resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       resolved_by = 'default-cites'
 WHERE kind = 'edge_type' AND status = 'pending';

UPDATE meta SET value = '28' WHERE key = 'schema_version';
