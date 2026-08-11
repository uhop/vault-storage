# @uhop/vault-storage-mcp [![npm version][npm-img]][npm-url]

[npm-img]: https://img.shields.io/npm/v/%40uhop%2Fvault-storage-mcp.svg
[npm-url]: https://www.npmjs.com/package/@uhop/vault-storage-mcp

MCP adapter for [vault-storage](https://github.com/uhop/vault-storage). Exposes
the REST API as MCP tools and resources for Claude Code (and any other
MCP-compatible client).

This is a thin protocol adapter — it holds no vault state. Every call goes
through to a running `vault-storage` REST server identified by `VAULT_API_URL`.

## Install

In your Claude Code MCP config (`~/.claude/.mcp.json` or per-project
`.claude/.mcp.json`):

```json
{
  "mcpServers": {
    "vault": {
      "command": "npx",
      "args": ["-y", "@uhop/vault-storage-mcp@latest"],
      "env": {
        "VAULT_API_URL": "http://your-host:8123",
        "VAULT_API_TOKEN": "<bearer-token>"
      }
    }
  }
}
```

The bearer token is the same `VAULT_API_TOKEN` your `vault-storage` server
was started with (e.g., the one in your `.env`).

## Tools

Fifty-three tools mapping to the REST surface, grouped by purpose:

- **Search & list** — `vault_search`, `vault_context_pack` (one prepared
  RAG pack — hybrid top-K chunks + a deduped 1-hop graph whose inbound
  entries are the backlinks, byte-budgeted chunks-first with every trim
  reported — replacing the search → similar → neighborhood → read chains),
  `vault_list_pieces` (filters incl. alias-aware `tag`), `vault_list_folder`
- **Read** — `vault_read_piece`, `vault_read_meta`, `vault_read_file`
  (`include_etag: true` returns `{path, etag, composed, content}` — the
  tag a conditional write needs, and the composed-folder flag)
- **Narrow write** — `vault_append`, `vault_replace` (asserted: a missing
  or ambiguous target is a 409, never a silent no-op), `vault_patch_fm`
  (add/remove one frontmatter array member). All three are atomic
  server-side ops whose blast radius is the thing being changed, so they
  cannot lose the rest of the document. Prefer them over whole-document
  writes.
- **Whole-document write** — `vault_write_file`, `vault_update_piece`,
  `vault_delete_file`. Both writers accept `agent.derived_from_hash:
"auto"` (the server stamps the body hash + `derived_at`) and an optional
  `expected_etag`, sent as `If-Match`: the write lands only if nobody
  else wrote in between, otherwise `412` with the current tag to retry
  against. Empty and literal-`"null"` bodies are refused server-side —
  removal is `vault_delete_file`.
- **Lifecycle** — `vault_supersede` (replace a note, archiving the
  predecessor with its `record_id` — and therefore its edges, embeddings,
  and suggestions — intact), `vault_move` (rename, same id preservation),
  `vault_propose` (search-before-write: score a draft against existing
  notes before minting a near-duplicate)
- **Maintenance** — `vault_raw_inbox` (the `raw/` ready/drafts split that
  starts `/vault ingest`), `vault_cleanup_lint`, `vault_embed_pending`,
  `vault_incremental_reindex` (catch up after a `git pull` from another
  machine), `vault_run_scans` (all four suggestion-filing scans in one
  pass)
- **Tags** — `vault_list_tags`, `vault_tag_info`, `vault_records_by_tag`
- **Insight** — `vault_neighborhood`, `vault_similar`, `vault_backlinks`
- **Review queue** — `vault_list_suggestions` (`expand: "context"` inlines
  per-item record briefs + tag taxonomy info), `vault_read_suggestion`,
  `vault_suggestions_summary`, `vault_claim_suggestions` (reserve a batch
  for one triage session: holder + TTL, lazy expiry),
  `vault_accept_suggestion`, `vault_reject_suggestion`,
  `vault_resolve_suggestions_batch` (≤ 100 decisions per call, mechanical
  tag/edge side effects applied server-side), `vault_reopen_suggestion`
  (also the explicit claim release), `vault_create_suggestion`
- **Queue items** — `vault_queue_top`, `vault_queue_ready`, `vault_queue_blocked`,
  `vault_queue_by_section`, `vault_queue_by_priority`, `vault_queue_by_project`,
  `vault_queue_project_archive`, `vault_queue_reindex`
- **Repo leases** (agent coordination) — `vault_lease_list`, `vault_lease_events`,
  `vault_lease_claim` (atomic; precedence human > cwd agent > side agent; side
  claims attest a clean checkout), `vault_lease_renew`, `vault_lease_release`
  (`force` = operator hatch), `vault_lease_transfer` (atomic handover)
- **System** — `vault_status`, `vault_lint` (integrity checks plus the
  `coverage.enrichment` block and its `unenriched_records` worklist),
  `vault_resume_bundle` (one-shot session-start bundle: reindex + lint +
  suggestions + workflow + log summaries + project notes; `project_bodies`
  opts named project files into full-body delivery)

Tool input schemas inline closed-enum lists (record types, statuses, edge
types, suggestion kinds) so the agent learns the canonical surface at
discovery time, and every description names the response shape it returns
— including conditional keys (`requested` on an alias lookup) and which of
the three list shapes it uses: the paginated `{items, offset, limit, total}`
envelope (page by `items.length`; the server caps `limit` at 100), the flat
`{count, items}` queue slices, or a genuinely unpaginated read.

## Resources

Three read-only resources the agent can fetch by URI:

- `vault://status` — indexer state, schema version, counts
- `vault://suggestions/pending` — bulk pending review items
- `vault://taxonomy/tags` — managed tag taxonomy with counts

## Errors

Server errors surface as MCP tool errors (`isError: true`) with a JSON
payload `{error, code, status, details}`. Common codes:

- `auth_failed` — `VAULT_API_TOKEN` missing or wrong
- `not_found` — record/file/tag/suggestion absent
- `conflict` — already-resolved suggestion, etc.
- `replace_assert_failed` — `vault_replace` target missing, or ambiguous
  without `all` (`details.occurrences` carries the count)
- `precondition_failed` — `expected_etag` is stale;
  `details.current_etag` is what to re-read and retry against
- `empty_body` / `null_body` — the write would leave the document with no
  content; use `vault_delete_file` to remove one
- `network` — server unreachable
- `bad_request`, `validation_failed`, `internal`

## Release notes

- 0.3.1 — `vault_context_pack` description corrected to the server's revised
  graph shape: the separate `backlinks` array is gone (inbound neighborhood
  entries are the backlinks; `inbound_total` carries the degree), the whole
  response is byte-budgeted chunks-first (neighborhood trims before any chunk
  drops), and degenerate segments are skipped. Docs only — the adapter is a
  pass-through, so 0.3.0 works against the new server but overstates the
  graph block.
- 0.3.0 — new `vault_context_pack` tool (47 tools): one prepared RAG pack —
  hybrid top-K chunks, 1-hop graph summaries, backlinks — byte-budgeted with
  reported drops; `vault_resume_bundle` documents the server's budget-gated
  feedback body; `llms.txt` / `llms-full.txt` ship in the tarball.
- 0.2.0 — every tool description audited against live response shapes: the
  three list shapes named explicitly, conditional keys documented, wrong
  claims fixed; description-pin tests added.
- 0.1.0 — parity with the REST surface (46 tools): narrow writes
  (`vault_append` / `vault_replace` / `vault_patch_fm`), conditional
  whole-document writes (`expected_etag`), lifecycle
  (`vault_supersede` / `vault_move` / `vault_propose`), maintenance ops.
- 0.0.x — initial reads-mostly surface.

## Development

```bash
npm install
npm test
```

Tests use a fake `fetch` to exercise client behaviour; smoke tests verify
tool/resource registration, and description-pin tests hold tool descriptions
to the real response shapes. Plain JavaScript — there is no type-check step
in this sub-package.
