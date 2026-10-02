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
was started with (for example, the one in your `.env`).

At startup the adapter asks the server to load its embedding model
(`POST /maintenance/warm-embedder`), so the first semantic search of a session
does not wait for the load. It does not wait for the answer, and a server
that is down or older changes nothing.

## Tools

The tools map to the REST surface, grouped by purpose:

- **Search & list** — `vault_search` (`edge` keeps the hits whose typed
  edges meet every condition, `edges: true` lists each hit's edges),
  `vault_search_facets` (how many of a
  query's matches carry each edge type each way, the counts behind
  `vault_search`'s `edge` filter), `vault_context_pack` (one prepared
  RAG pack — hybrid top-K chunks + a deduped 1-hop graph whose inbound
  entries are the backlinks, byte-budgeted chunks-first with every trim
  reported — replacing the search → similar → neighborhood → read chains),
  `vault_list_pieces` (filters incl. alias-aware `tag`), `vault_list_folder`
- **Read** — `vault_read_piece`, `vault_read_meta`, `vault_read_file`
  (`include_etag: true` returns `{path, etag, composed, content}` — the
  tag a conditional write needs, and the composed-folder flag; `at`, a commit
  from `vault_history`, reads the note as it was then),
  `vault_read_section` (one ATX-heading section as
  `{path, etag, heading, level, occurrence, content, hash}`, so a large
  document never has to be pulled into context to read one part of it;
  `occurrence` picks one of several identical headings)
- **Narrow write** — `vault_append`, `vault_replace` (asserted: a missing
  or ambiguous target is a 409, never a silent no-op),
  `vault_replace_section` (the content under one heading, matched exactly
  once with code fences masked, to the next heading of the same or higher
  level; same assert; `expected_hash` from the read refuses a section that
  changed since), `vault_remove_item` / `vault_insert_item` /
  `vault_move_item` (one queue item by its bold title — removed, inserted
  into a section, or moved between documents with a trail after the title,
  the queue-to-archive move as one request; an inserted item whose `source:`
  an open item already carries updates that item, or with `on_existing:
"keep"` writes nothing), `vault_patch_fm` (add/remove
  one frontmatter array member, `tags:` excepted), `vault_tag_add` /
  `vault_tag_remove` (one `tags:` member). All of them are atomic
  server-side ops whose blast radius is the thing being changed, so they
  cannot lose the rest of the document. Prefer them over whole-document
  writes. The body edits and the item ops take an optional `agent` patch
  (`vault_move_item`: `from_agent` / `to_agent`), merged over the stored
  `agent:` block and stamped current for the new body, so the writer keeps
  the enrichment fresh in the same request; `agent: {}` says the summary
  still holds, and over a summary already stale it leaves the block stale
  and the answer carries `agent_stale: true`.
- **Whole-document write** — `vault_write_file`, `vault_update_piece`,
  `vault_delete_file`. Both writers accept `agent.derived_from_hash:
"auto"` (the server stamps the body hash + `derived_at`) and an optional
  `expected_etag`, sent as `If-Match`: the write lands only if nobody
  else wrote in between, otherwise `412` with the current tag to retry
  against. Empty and literal-`"null"` bodies are refused server-side —
  removal is `vault_delete_file`. A `tags:` entry the taxonomy does not
  know still writes and files a `new_tag` suggestion, and the answer then
  carries `unknown_tags` with the nearest existing tags; `strict_tags: true`
  refuses the write with `409 unknown_tags` instead. Check names with
  `vault_tag_nearest` first. Relations go in the frontmatter's `edges:` map
  (`{<wikilink target>: <type>}`), stored as edges whether or not the body
  links the target; a type outside the vocabulary is a `400 invalid_enum_value`,
  an unresolved target answers with `unresolved_edges`, and `strict_edges: true`
  refuses that with `409 unresolved_edges`.
- **History** — `vault_history` (a note's committed versions, newest first,
  following renames), `vault_history_diff` (what changed between two
  versions, or a version and the note on disk: a unified diff of the
  markdown, or a word diff for prose), `vault_restore` (write a version
  back through the writer; content not yet committed is committed first, so
  it stays a version)
- **Lifecycle** — `vault_supersede` (replace a note, archiving the
  predecessor with its `record_id` — and therefore its edges, embeddings,
  and suggestions — intact), `vault_move` (rename, same id preservation),
  `vault_propose` (search-before-write: score a draft against existing
  notes before minting a near-duplicate)
- **Maintenance** — `vault_raw_inbox` (the `raw/` ready/drafts split that
  starts `/vault ingest`), `vault_cleanup_lint`, `vault_embed_pending`,
  `vault_incremental_reindex` (catch up after a `git pull` from another
  machine), `vault_run_scans` (all four suggestion-filing scans in one
  pass), `vault_gc_tags` (delete taxonomy tags no record carries, except
  `manual` ones; a dry run unless `dry_run: false`)
- **Edges** — `vault_list_edges` (every stored edge by type, paged, with per-type counts).
- **Tags** — `vault_list_tags`, `vault_tag_info`, `vault_tag_nearest`, `vault_records_by_tag`,
  `vault_tag_create` (`origin: manual` for a tag made on purpose),
  `vault_tag_update` (rewrite a description, or re-label `origin`),
  `vault_tag_alias`, `vault_tag_delete` (strip a tag from every note, then
  drop it), `vault_tag_add` / `vault_tag_remove` (one tag on one record)
- **Projects** — `vault_project_trackers` (where a project's work is tracked and
  which tracker is primary, from its queue's `trackers:` frontmatter; the vault
  when none is declared), `vault_project_changes` (the notes and queue items
  changed since a time or a commit), `vault_fleet_status` (the stored GitHub
  and npm baselines that fleet-status collected, with a project's tracked
  threads), `vault_links` (the notes and queue items that mention a ticket, a
  design, or any URL)
- **Insight** — `vault_neighborhood`, `vault_similar`, `vault_backlinks`,
  `vault_enrichment_delta` (the chunks added to a body since its `agent:` block
  was current, for a refresh that reads the change instead of the whole note)
- **Review queue** — `vault_list_suggestions` (`expand: "context"` inlines
  per-item record briefs + tag taxonomy info), `vault_read_suggestion`,
  `vault_suggestions_summary`, `vault_claim_suggestions` (reserve a batch
  for one triage session: holder + TTL, lazy expiry),
  `vault_accept_suggestion`, `vault_reject_suggestion`,
  `vault_resolve_suggestions_batch` (≤ 100 decisions per call, mechanical
  tag/edge side effects applied server-side), `vault_reopen_suggestion`
  (also the explicit claim release, with the claim's `claim_token`), `vault_create_suggestion`
- **Queue items** — `vault_queue_top`, `vault_queue_ready`, `vault_queue_blocked`,
  `vault_queue_by_section`, `vault_queue_by_priority`, `vault_queue_by_project`,
  `vault_queue_project_archive` (all seven take `fields` — `"a,b"` keeps,
  `"-a,-b"` drops, identity fields stay — with `exclude: "body"` as the
  older alias for `fields: "-body"`; a listing without the item prose is
  about a fifth of the bytes),
  `vault_queue_reindex`
- **Repo leases** (agent coordination) — `vault_lease_list`, `vault_lease_events`,
  `vault_lease_claim` (atomic; precedence human > cwd agent > side agent, and a
  cwd lease unrenewed for an hour yields to a cwd claim; side claims attest a
  clean checkout), `vault_lease_renew`, `vault_lease_release`
  (`force` = operator hatch), `vault_lease_transfer` (atomic handover)
- **Handoffs** (agent coordination) — `vault_handoff_create` (idempotency key
  mandatory; role-addressed, never a session), `vault_handoff_list` (the
  lease holder's inbox is `status=open`), `vault_handoff_get` (the poller's
  read), `vault_handoff_claim` (lazy claim expiry), `vault_handoff_resolve`
  (`done`/`rejected` archive into the project's `handoff-archive.md`;
  `returned` reopens the same record with a mandatory critique note),
  `vault_handoff_resubmit`, `vault_handoff_note`, `vault_handoff_verify` (a
  gate's result bound to the sha it ran on and to the artifact on record,
  shown `stale` once that artifact is replaced), `vault_handoff_events`,
  `vault_handoff_put_artifact` / `vault_handoff_get_artifact` (the transported
  work — a `git format-patch` series or a bundle, 10 MB cap; the getter
  returns metadata unless `include_content` is set)
- **System** — `vault_status`, `vault_health` (the process from memory
  alone: watchdog lag, last git-sync and reindex outcomes, `stalled`),
  `vault_lint` (integrity checks plus the
  `coverage.enrichment` block and its `unenriched_records` worklist),
  `vault_resume_bundle` (one-shot session-start bundle: reindex + lint +
  suggestions + workflow + log summaries + project notes + the project's
  handoff inbox, its own latest logs, its session records, what changed since
  its last working session, and its tracker declaration; `project_bodies`
  opts named project files into full-body delivery)

Tool input schemas inline closed-enum lists (record types, statuses, edge
types, suggestion kinds) so the agent learns the canonical surface at
discovery time, and every description names the response shape it returns
— including conditional keys (`requested` on an alias lookup) and which of
the three list shapes it uses: the paginated `{items, offset, limit, total}`
envelope (page by `items.length`; the server caps `limit` at 100), the flat
`{count, items}` queue slices, or a genuinely unpaginated read. Every list envelope, every queue slice, and the resume
bundle also carry `as_of: {generation, indexed_commit, at}`, the content
generation the answer was computed at, so an empty answer reads as "empty at
generation N"; `vault_search` returns `{as_of, hits}` for the same reason.

## Resources

Read-only resources the agent can fetch by URI:

- `vault://status` — indexer state, schema version, counts
- `vault://suggestions/pending` — bulk pending review items
- `vault://taxonomy/tags` — managed tag taxonomy with counts

## Errors

Server errors surface as MCP tool errors (`isError: true`) with a JSON
payload `{error, code, status, details}`; the server's own body also carries
the RFC 9457 Problem Details members (`type`, `title`, `status`, `detail`)
beside them. An argument a tool does not declare is refused before any
request, as an invalid-arguments error naming the key and the accepted ones,
so an adapter older than the server never drops a field silently. Common
codes:

- `auth_failed` — `VAULT_API_TOKEN` missing or wrong
- `forbidden` — the act needs a person's key, such as a forced lease release
  with an agent's key (server from D135)
- `not_found` — record/file/tag/suggestion absent
- `conflict` — the destination of a move or supersede is taken, the tag is
  already in the taxonomy, or a suggestion changed between the server's
  check and its write (read it again)
- `replace_assert_failed` — `vault_replace` target missing, or ambiguous
  without `all` (`details.occurrences` carries the count)
- `section_assert_failed` — `vault_read_section` / `vault_replace_section`
  heading absent or ambiguous, or `occurrence` past the last
  (`details.occurrences` carries the count)
- `section_changed` — `vault_replace_section` `expected_hash` is stale;
  `details.current_hash` is the section's hash now
- `precondition_failed` — `expected_etag` is stale;
  `details.current_etag` is what to re-read and retry against
- `empty_body` / `null_body` — the write would leave the document with no
  content; use `vault_delete_file` to remove one
- `claimed_by_other` — the suggestion, repo lease, or handoff is held by
  another holder, or (suggestions) the `claim_token` is missing or another
  claim's (`details.current` carries the current lease on `vault_lease_*`,
  the current handoff on `vault_handoff_*`)
- `claim_token_mismatch` — your holder name holds the lease or handoff, but
  under a claim whose `claim_token` you did not pass; a claim returns its
  token once, and renew, release, transfer, and resolve need it
- `lease_not_found` — renew/release/transfer on a resource nothing holds;
  after an expiry, re-claim instead
- `handoff_not_found` — no handoff with that id (a resolved one stays
  readable until the next server restart; after that its record is the
  project's `handoff-archive.md`)
- `not_open` — claiming a handoff that is claimed, returned, or resolved
- `not_claimed` — resolving a handoff nobody has claimed; claim it first
- `not_returned` — resubmitting a handoff that is not awaiting rework
- `handoff_resolved` — adding a note or artifact to a done/rejected handoff
- `artifact_not_found` — the handoff carries no artifact
- `artifact_too_large` — over the 10 MB spool cap; reference a branch
  instead of shipping a blob
- `network` — the server did not answer; `details.cause` carries the
  socket's error code and `details.attempts` the number of tries. A refused
  connection (`ECONNREFUSED`) sent nothing, so the request is repeated every
  half second for eight seconds, which outlasts a server restart. A read is
  repeated the same way after any network failure. A write whose connection
  dropped after the request went out is not repeated, since it may have
  applied: read the document before sending it again
- `bad_request`, `validation_failed`, `internal`

## Release notes

- 0.13.0 — a note's history, what changed in a project, and search by typed
  edges: `vault_history` lists a note's committed versions, `vault_read_file`
  reads one with `at`, and `vault_restore` writes one back, committing the
  current content first so it stays a version; `vault_project_changes` lists
  a project's notes and queue items changed since a time or a commit, and the
  resume bundle carries the same since the last working session, beside the
  project's own logs, its session records, and its tracker declaration.
  `vault_search` keeps the hits whose typed edges meet `edge` conditions and
  lists each hit's edges with `edges: true`, and `vault_search_facets` counts
  how many of a query's matches carry each edge type each way.
  `vault_fleet_status` reads the stored GitHub and npm baselines with the
  tracked threads, and `vault_links` lists the notes that mention a ticket, a
  design, or any URL. `vault_insert_item` updates the open item that carries
  the inserted `source:` instead of filing it twice (`on_existing: "keep"`
  leaves it), and the queue reads carry `source` and the Inbox. An `agent: {}`
  patch over a summary that was already stale leaves the block stale and the
  answer says `agent_stale: true`. The descriptions name what the server added:
  `vault_lint`'s `frontmatter_outside_enum` and `import_failures`,
  `vault_status`'s vault marker, the `secondary` role and `intake` in
  `vault_project_trackers`, and a mirrored `contradicts` pair listed once by
  `vault_list_edges`. The new tools and parameters need vault-storage from
  2026-10-01: an older server answers a new tool with a 404 and a new
  parameter with a 400 for an unknown field.
- 0.12.0 — tags picked from the taxonomy, relations declared on the write, and
  calls that outlast a server restart: `vault_tag_nearest` returns the nearest
  existing tags for proposed names or a draft's text, and `vault_write_file`,
  `vault_update_piece`, and `vault_supersede` take `strict_tags` and
  `strict_edges`, which refuse a write that carries an unknown tag (409
  `unknown_tags`, with the nearest tags) or an `edges:` target that resolves
  to no note (409 `unresolved_edges`); without them the write lands and the
  answer names both. `vault_tag_create` (with a `dry_run` preview of overlaps
  and reach), `vault_tag_alias`, `vault_tag_delete`, and `vault_gc_tags` cover
  a tag's life, and `vault_tag_update` takes `origin`. `vault_list_edges`
  pages the stored edges by type, `vault_neighborhood` takes `fields` and
  `edge_fields`, and `vault_project_trackers` says where a project's work is
  tracked. An edge-type filter takes the server's seven types; `caused-by`,
  `fixed-by`, and `rejected-because` are gone from it. A refused connection
  is repeated every half second for eight seconds, a read after any network
  failure, and a `network` error names its cause in `details.cause`; a write
  whose connection dropped is reported as possibly applied and is not
  repeated. At startup the adapter asks the server to load its embedding
  model, so the first semantic search does not wait for it. The new tools and
  parameters need vault-storage from 2026-09-28: an older server answers a
  new tool with a 404 and a new parameter with a 400 for an unknown field.
- 0.11.0 — enrichment kept current by the writer, and strict tool
  arguments: `vault_append`, `vault_replace`, `vault_replace_section`,
  `vault_remove_item`, and `vault_insert_item` take an optional `agent`
  patch, and `vault_move_item` takes `from_agent` and `to_agent`, merged over
  the stored `agent:` block and stamped current for the new body, so the
  edit files no stale-enrichment suggestion (`agent: {}` says the summary
  still holds). `vault_enrichment_delta` returns the chunks added to a body
  since its `agent:` block was derived. A tool now refuses an argument it
  does not declare, naming it, where it used to drop it silently. The new
  parameters need vault-storage from 2026-09-27 (D74); an older server
  answers them with a 400 for an unknown body field.
- 0.10.0 — sorted and filtered tag listing: `vault_list_tags` takes `sort`
  (`count`, the default, most used first; `count_asc`; `tag_asc`, A to Z;
  `tag`, Z to A) and `contains`, a substring of the tag name, and each item
  carries the tag's `description`. `vault_records_by_tag` returns the most
  recently updated records first. The parameters need vault-storage from
  2026-09-27; an older server answers them with a 400 for an unknown
  parameter, and calls without them are unchanged.
- 0.9.0 — claim tokens and tag tools: every agent claim, whether a lease's, a
  handoff's, or a suggestion batch's, returns a `claim_token` once, and
  `vault_lease_renew`, `vault_lease_release`, `vault_lease_transfer`,
  `vault_handoff_resolve`, a renewing re-claim, and
  `vault_accept_suggestion` / `vault_reject_suggestion` /
  `vault_resolve_suggestions_batch` / `vault_reopen_suggestion` on a claimed
  item take it, so two claims under one holder name never settle each other's
  work (409 `claim_token_mismatch` or `claimed_by_other` without it).
  `vault_tag_add` and `vault_tag_remove` add or remove one tag on one record,
  and `vault_patch_fm` no longer advertises `/tags`, which the server refuses.
  The `vault_write_file` and `vault_update_piece` descriptions name the
  `agent.complexity` values. The claim tokens need vault-storage from
  2026-09-27, whose server refuses those calls without them; against an older
  server the extra parameter is recorded and ignored.
- 0.8.0 — guarded section edits and a tag-description tool:
  `vault_read_section` takes `occurrence` to pick one of several identical
  heading lines and returns the section's `hash`, and `vault_replace_section`
  takes the same `occurrence` plus `expected_hash`, so a save fails with
  `section_changed` instead of overwriting a section someone changed;
  `vault_tag_update` rewrites a canonical tag's description. `vault_propose` no
  longer advertises `agent_summary`, which the server refuses since 2026-09-15,
  so a call that followed the old schema stops failing. Tool descriptions now
  match the server: the context pack's semantic ranking, the lease rule that a
  `cwd` lease unrenewed for an hour yields to a `cwd` claim (with `prior` in
  the answer), handoff verifications bound to the head commit, and queue slices
  kept current by every import. `vault_tag_update` needs vault-storage from
  2026-09-16, and the section parameters from 2026-09-18; calls without them
  are unchanged against older servers.
- 0.7.0 — section, item, and health tools, and response subsetting:
  `vault_read_section` / `vault_replace_section` read or rewrite the content
  under one ATX heading and leave every other byte alone; `vault_remove_item`,
  `vault_insert_item`, and `vault_move_item` address a queue bullet by its bold
  title, the move writing the destination before the source and inserting a
  trail after the title; `vault_handoff_verify` records a gate run bound to a
  commit, shown `stale` once the artifact's base moves, and handoffs declare
  `touches` on create and resubmit with overlaps reported in the list;
  `vault_health` answers from the server's memory alone, so a wedged store is
  told apart from a dead process. `fields=` subsets the responses of nine tools
  (an include list or a `-`-prefixed exclude list; `exclude=body` stays as the
  alias on the queue tools); every list envelope, queue slice, the resume bundle
  and the brief carry `as_of`, and `vault_search` returns `{as_of, hits}`; the
  bundle and brief mark `summary_stale`; suggestion payloads carry `evidence`;
  error bodies add the RFC 9457 members; `vault_lint` carries `queue_hygiene`.
  The new tools and parameters need vault-storage from 2026-09-07 (migration
  0021); calls without them are unchanged against older servers.
- 0.6.0 — the handoff patch transport (63 tools): `vault_handoff_put_artifact`
  attaches the work a reviewer actually applies — a `git format-patch --base=…`
  series, or a base64 `bundle` for binary/multi-branch — and
  `vault_handoff_get_artifact` reads it back, returning metadata unless
  `include_content` is set, since a patch belongs in a file rather than in an
  agent's context. Capped at 10 MB. The upload re-points the handoff's `ref` at
  the spool; that ref type is server-set and cannot be declared on create. This
  is what makes a handoff work across machines: agents cannot `git push`, so the
  singleton server's spool is the fleet's shared storage. Requires vault-storage
  schema 19 for the `/handoffs/{id}/artifact` pair; every other tool is
  unchanged against older servers.
- 0.5.0 — handoff tools for agent coordination (61 tools):
  `vault_handoff_create` / `vault_handoff_list` / `vault_handoff_get` /
  `vault_handoff_claim` / `vault_handoff_resolve` / `vault_handoff_resubmit` /
  `vault_handoff_note` / `vault_handoff_events` — role-addressed cross-agent
  work requests with a mandatory idempotency key, a claim/review loop that can
  return work for rework, and append-only discussion. Handoffs are durable
  (server-side spool, rebuilt by scan on restart) and archive into the target
  project's `handoff-archive.md` when resolved. `vault_resume_bundle`'s
  project block now carries the repo's handoff inbox, so a session sees the
  work it inherited. Requires vault-storage ≥ 2026-08-10 (schema 18) for the
  `/handoffs` endpoints; every other tool is unchanged against older servers.
- 0.4.0 — repo-lease tools for agent coordination (53 tools):
  `vault_lease_list` / `vault_lease_events` / `vault_lease_claim` /
  `vault_lease_renew` / `vault_lease_release` / `vault_lease_transfer` —
  atomic claim with the human > cwd-agent > side-agent precedence lattice,
  clean-checkout attestation on side claims, operator force-release, atomic
  transfer; `vault_resolve_suggestions_batch` accepts the `basis-for`
  declaration alias on `edge_type` accepts (stored as `derived-from` with the
  edge flipped). Requires vault-storage ≥ 2026-08-10 for the `/leases`
  endpoints; every other tool is unchanged against older servers.
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

Before a publish, the consumer smoke at the repository root, `node
scripts/mcp-smoke.mjs`, spawns the staged adapter and speaks JSON-RPC over
stdio to the live server named by `VAULT_API_URL`: the tool list against
`registerTools`, `vault_health`, one read tool, and one `fields=` subset.
