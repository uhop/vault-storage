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

Thirty-one tools mapping to the REST surface, grouped by purpose:

- **Search & list** — `vault_search`, `vault_list_pieces` (filters incl.
  alias-aware `tag`), `vault_list_folder`
- **Read** — `vault_read_piece`, `vault_read_meta`, `vault_read_file`
- **Write** — `vault_write_file`, `vault_update_piece`, `vault_delete_file`
  (writes accept `agent.derived_from_hash: "auto"` — the server stamps the
  body hash + `derived_at`)
- **Tags** — `vault_list_tags`, `vault_tag_info`, `vault_records_by_tag`
- **Insight** — `vault_neighborhood`, `vault_similar`, `vault_backlinks`
- **Review queue** — `vault_list_suggestions` (`expand: "context"` inlines
  per-item record briefs + tag taxonomy info), `vault_read_suggestion`,
  `vault_suggestions_summary`, `vault_accept_suggestion`,
  `vault_reject_suggestion`, `vault_reopen_suggestion`,
  `vault_create_suggestion`
- **Queue items** — `vault_queue_top`, `vault_queue_by_section`,
  `vault_queue_by_priority`, `vault_queue_by_project`,
  `vault_queue_project_archive`, `vault_queue_reindex`
- **System** — `vault_status`, `vault_lint`, `vault_resume_bundle` (one-shot
  session-start bundle: reindex + lint + suggestions + workflow + log
  summaries + project notes)

Tool input schemas inline closed-enum lists (record types, statuses, edge
types, suggestion kinds) so the agent learns the canonical surface at
discovery time.

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
- `network` — server unreachable
- `bad_request`, `validation_failed`, `internal`

## Development

```bash
npm install
npm run ts-check
npm test
```

Tests use a fake `fetch` to exercise client behaviour; smoke tests verify
tool/resource registration.
