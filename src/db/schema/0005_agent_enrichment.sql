-- 0005 — agent-derived frontmatter enrichment columns.
--
-- Stores the LLM-authored `agent:` block from the source markdown's
-- frontmatter so the chunker / embedder can pull `agent.summary` as a HyDE
-- prefix at index time. Refines C12 per
-- `[[projects/vault-storage/design/agent-frontmatter-enrichment]]`:
-- top-level frontmatter is user-authored; the `agent:` namespace is
-- agent-authored derived state.
--
-- Both columns are nullable. Records that don't have an `agent:` block in
-- their FM (the entire current vault until enrich-all runs) leave them NULL
-- and the chunker / embedder operate on body alone — same behavior as
-- before this migration.
--
-- Why two columns:
--   agent_summary           — the prefix the chunker prepends to each chunk.
--   agent_derived_from_hash — the body content_hash recorded by the LLM at
--                             derivation time. Compare to current
--                             content_hash to detect staleness without
--                             re-running the LLM. Used by future lint /
--                             suggestion filing logic; populated now so the
--                             data is available when that lands.

ALTER TABLE records ADD COLUMN agent_summary TEXT;
ALTER TABLE records ADD COLUMN agent_derived_from_hash TEXT;

UPDATE meta SET value = '5' WHERE key = 'schema_version';
