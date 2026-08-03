// MCP tool registrations. Every tool wraps one REST endpoint of the
// vault-storage server. Input schemas are inlined (closed enums, default
// values) so the agent learns the canonical surface at tool-discovery time.

import {z} from 'zod';
import {VaultClientError} from './client.js';

const RECORD_TYPE = z.enum([
  'idea',
  'design',
  'plan',
  'queue-item',
  'research',
  'bug-report',
  'project',
  'permanent',
  'log',
  'query',
  'fleeting',
  'state',
  'meta',
  'index'
]);

const RECORD_STATUS = z.enum(['active', 'draft', 'done', 'superseded', 'archived']);

const EDGE_TYPE = z.enum([
  'supersedes',
  'revises',
  'derived-from',
  'caused-by',
  'fixed-by',
  'rejected-because',
  'cites',
  'applies-to',
  'contradicts',
  'related-to'
]);

const SUGGESTION_KIND = z.enum([
  'edge_type',
  'duplicate',
  'archive_candidate',
  'merge_candidate',
  'compaction_candidate',
  'contradiction_candidate',
  'tag_suggestion',
  'new_tag',
  'inefficiency_detected',
  'infrastructure_upgrade',
  'frontmatter_inference_ambiguous',
  'agent_enrichment_stale'
]);

const SUGGESTION_STATUS = z.enum(['pending', 'claimed', 'accepted', 'rejected']);

const json = value => ({
  content: [{type: 'text', text: JSON.stringify(value, null, 2)}]
});

const text = value => ({content: [{type: 'text', text: value}]});

/**
 * Wrap a tool handler so any VaultClientError surfaces as `isError: true`
 * with structured details — the agent sees a consistent shape for every
 * REST failure and the underlying error code.
 */
const wrap = handler => async args => {
  try {
    const result = await handler(args);
    if (result === undefined || result === null) return text('OK');
    if (typeof result === 'string') return text(result);
    return json(result);
  } catch (err) {
    if (err instanceof VaultClientError) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: err.message,
                code: err.code,
                status: err.status,
                details: err.details
              },
              null,
              2
            )
          }
        ],
        isError: true
      };
    }
    throw err;
  }
};

const csv = arr => (arr && arr.length > 0 ? arr.join(',') : undefined);

export const registerTools = (mcp, client) => {
  // ── search ────────────────────────────────────────────────────────────────
  mcp.registerTool(
    'vault_search',
    {
      description:
        'Search the vault by lexical query (default) or semantic similarity (mode=semantic). Returns up to `limit` hits as [{filename, score, matches: [{match, context}]}].',
      inputSchema: {
        query: z.string().min(1).describe('Search query text'),
        mode: z.enum(['lexical', 'semantic']).optional().default('lexical'),
        limit: z.number().int().min(1).max(100).optional().default(20)
      }
    },
    wrap(async ({query, mode, limit}) =>
      client.postJson('/search/simple/', undefined, {query, mode, limit})
    )
  );

  // ── records (sections) ────────────────────────────────────────────────────
  mcp.registerTool(
    'vault_list_pieces',
    {
      description:
        'List records (atomized pieces or whole-file records) with filters. Returns the paginated envelope {items, offset, limit, total}, items being full record rows (add exclude: "body" to drop the bodies). Page by items.length, never by the limit you asked for — the server caps limit at 100 and echoes the value it actually used, so requesting 200 returns 100 and stepping offset by 200 silently skips half of every page.',
      inputSchema: {
        type: z.array(RECORD_TYPE).optional(),
        status: z.array(RECORD_STATUS).optional(),
        tag: z
          .array(z.string().min(1))
          .optional()
          .describe('Tags (aliases resolve; unknown tags are a 400)'),
        file_prefix: z.string().optional().describe('Vault-relative path prefix'),
        priority_min: z.number().int().optional(),
        priority_max: z.number().int().optional(),
        updated_since: z.string().optional().describe('ISO date'),
        sort: z
          .enum(['priority', 'created', 'updated', 'last_referenced', 'decay_score', 'file_path'])
          .optional(),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(20),
        exclude: z.enum(['body']).optional().describe('Set to "body" to omit body fields')
      }
    },
    wrap(async args =>
      client.getJson('/sections', {
        type: csv(args.type),
        status: csv(args.status),
        tag: csv(args.tag),
        file_prefix: args.file_prefix,
        priority_min: args.priority_min,
        priority_max: args.priority_max,
        updated_since: args.updated_since,
        sort: args.sort,
        offset: args.offset,
        limit: args.limit,
        exclude: args.exclude
      })
    )
  );

  mcp.registerTool(
    'vault_read_piece',
    {
      description: 'Read a single record by record_id (UUIDv7). Returns the record with body.',
      inputSchema: {
        record_id: z.string().min(1),
        exclude_body: z.boolean().optional()
      }
    },
    wrap(async ({record_id, exclude_body}) =>
      client.getJson(`/sections/${encodeURIComponent(record_id)}`, {
        exclude: exclude_body ? 'body' : undefined
      })
    )
  );

  mcp.registerTool(
    'vault_read_meta',
    {
      description:
        "Read a record without its body (cheap fetch). Returns the record row minus `body` — record_id, file_path, parent_path, sequence_key, type, status, priority, title, created, updated, modified_at, last_referenced, decay_score, content_hash, body_hash, archived_at. These are indexed DB fields, not the note's raw frontmatter block: arbitrary FM keys (tags, related, agent, edges) are not here. For the actual frontmatter, read the document with vault_read_file.",
      inputSchema: {record_id: z.string().min(1)}
    },
    wrap(async ({record_id}) => client.getJson(`/sections/${encodeURIComponent(record_id)}/meta`))
  );

  mcp.registerTool(
    'vault_update_piece',
    {
      description:
        'Replace a whole record via /sections/{id} PUT with `frontmatter` (JSON object) + `body` (markdown text). Same whole-document scope and the same alternatives as vault_write_file — vault_patch_fm for one frontmatter array, vault_append / vault_replace for body edits. The server serializes frontmatter to YAML itself — no YAML authoring, no quoting traps. User-authored keys are merged; `created`/`updated` are silently overridden by the indexer; DB-only keys like `record_id`/`content_hash` are rejected; an empty or literal-"null" body is rejected. expected_etag is sent as If-Match and makes the write conditional (412 `precondition_failed` on conflict, with details.current_etag); chain it from a previous write\'s returned etag. Returns the new etag.',
      inputSchema: {
        record_id: z.string().min(1),
        frontmatter: z
          .record(z.unknown())
          .describe('Frontmatter as a JSON object. The server handles YAML serialization.'),
        body: z.string().describe('Markdown body (no leading FM block).'),
        expected_etag: z.string().optional().describe('Sent as If-Match (412 on conflict)')
      }
    },
    wrap(async ({record_id, frontmatter, body, expected_etag}) => {
      const {etag} = await client.putJson(
        `/sections/${encodeURIComponent(record_id)}`,
        {frontmatter, body},
        expected_etag ? {ifMatch: expected_etag} : {}
      );
      return {ok: true, record_id, etag};
    })
  );

  // ── files (path-based) ────────────────────────────────────────────────────
  mcp.registerTool(
    'vault_read_file',
    {
      description:
        'Read a file by vault-relative path. Returns the markdown source. For atomized folders, the path can be the original `<stem>.md` and the server composes pieces back into one document. Set include_etag to get {path, etag, composed, content} instead — the etag is what vault_write_file takes as expected_etag, and composed=true marks a folder view that has no single file behind it and must be edited through its pieces.',
      inputSchema: {
        path: z.string().min(1),
        include_etag: z
          .boolean()
          .optional()
          .describe('Return a JSON envelope with the etag instead of bare markdown')
      }
    },
    wrap(async ({path, include_etag}) => {
      if (!include_etag) return client.getText(`/vault/${path}`);
      const {text, etag, composed} = await client.getTextWithMeta(`/vault/${path}`);
      return {path, etag, composed, content: text};
    })
  );

  mcp.registerTool(
    'vault_write_file',
    {
      description:
        'Create or REPLACE a whole file at a vault-relative path with `frontmatter` (JSON object) + `body` (markdown text). Whole-document scope: the body you send becomes the entire body and the frontmatter you send is merged over the stored one, so this is the wrong tool for a partial change — use vault_append / vault_replace for body edits and vault_patch_fm for one frontmatter key, all of which are atomic and cannot lose the rest of the document. Reach for this when authoring a new note or genuinely rewriting one. The server serializes frontmatter to YAML itself — no YAML authoring, no quoting traps. `created`/`updated` are silently overridden by the indexer; DB-only frontmatter keys (`record_id`, `content_hash`, `last_referenced`, `decay_score`) are rejected; an empty or literal-"null" body is rejected (removal is vault_delete_file). Pass expected_etag from a vault_read_file{include_etag} to make the write conditional — it is sent as If-Match, so the write lands only if nobody else wrote in between, otherwise 412 `precondition_failed` with details.current_etag to re-read and retry against. Returns the new etag for chaining.',
      inputSchema: {
        path: z.string().min(1).describe('Vault-relative path; must end with .md'),
        frontmatter: z
          .record(z.unknown())
          .describe('Frontmatter as a JSON object. The server handles YAML serialization.'),
        body: z.string().describe('Markdown body (no leading FM block).'),
        expected_etag: z
          .string()
          .optional()
          .describe('ETag from vault_read_file{include_etag}; sent as If-Match (412 on conflict)')
      }
    },
    wrap(async ({path, frontmatter, body, expected_etag}) => {
      const {etag} = await client.putJson(
        `/vault/${path}`,
        {frontmatter, body},
        expected_etag ? {ifMatch: expected_etag} : {}
      );
      return {ok: true, path, etag};
    })
  );

  // The narrow-blast-radius write path. `vault_write_file` replaces a whole
  // document, so a bug in the caller costs the whole document; these three
  // change only what they name, server-side and atomically, and cannot lose
  // the rest. Prefer them.
  mcp.registerTool(
    'vault_append',
    {
      description:
        'Append text to the end of a document body, server-side and atomically — no read-modify-write, so a concurrent writer cannot be clobbered. Frontmatter rides through untouched (`updated` is re-stamped). The document must already exist (404 otherwise); an atomized folder composed at `<stem>.md` is a 409 pointing at its pieces. Prefer this over vault_write_file whenever you are adding to a document rather than replacing it. Returns {path, etag}.',
      inputSchema: {
        path: z.string().min(1).describe('Vault-relative path; must end with .md'),
        text: z.string().min(1).describe('Fragment to append; joined after a single newline')
      }
    },
    wrap(async ({path, text}) => client.postJson('/vault/edit', {path, op: 'append', text}))
  );

  mcp.registerTool(
    'vault_replace',
    {
      description:
        'Replace a string in a document body, server-side and atomically. ASSERTED: an absent `from` is a 409 and an ambiguous one is a 409 carrying the occurrence count — never a silent no-op, which is what makes this safe to fire blind (the curly-vs-straight-apostrophe bug class). Pass all=true to replace every occurrence deliberately. Frontmatter rides through untouched. Prefer this over vault_write_file for targeted body edits. Returns {path, etag, replaced} — `replaced` is the occurrence count actually rewritten.',
      inputSchema: {
        path: z.string().min(1).describe('Vault-relative path; must end with .md'),
        from: z.string().min(1).describe('Exact text to find; must occur exactly once unless all'),
        to: z.string().describe('Replacement text; empty string deletes the match'),
        all: z.boolean().optional().describe('Replace every occurrence instead of asserting one')
      }
    },
    wrap(async ({path, from, to, all}) =>
      client.postJson('/vault/edit', {path, op: 'replace', from, to, ...(all ? {all} : {})})
    )
  );

  mcp.registerTool(
    'vault_patch_fm',
    {
      description:
        'Add or remove members of a frontmatter array (`/related`, `/tags`, `/agent/tags_suggested`, …) on one record, server-side and atomically. The body is never round-tripped, so this cannot clobber the document — the right tool for "add one related: entry", which would otherwise mean rewriting the whole note. Value-based set semantics: add appends unless a structurally-equal member exists, remove drops every equal member, both idempotent. Paths are JSON Pointers addressing the array itself, not an element. All-or-nothing: nothing is written unless every op validates, and a no-op request skips the write entirely. Returns {changed, results: [{op, path, changed, array}]} with each resulting array, so no re-read is needed.',
      inputSchema: {
        record_id: z.string().min(1).describe('Record id (not a path) — from vault_list_pieces'),
        ops: z
          .array(
            z.object({
              op: z.enum(['add', 'remove']),
              path: z.string().min(1).describe('JSON Pointer to the array, e.g. "/related"'),
              value: z.unknown().describe('Member value, e.g. "[[topics/foo]]"')
            })
          )
          .min(1)
      }
    },
    wrap(async ({record_id, ops}) =>
      client.patchJson(`/sections/${encodeURIComponent(record_id)}/fm`, {ops})
    )
  );

  mcp.registerTool(
    'vault_delete_file',
    {
      description: 'Delete a file at a vault-relative path. Cascades to the DB row + edges + tags.',
      inputSchema: {path: z.string().min(1)}
    },
    wrap(async ({path}) => {
      await client.deletePath(`/vault/${path}`);
      return {ok: true, path};
    })
  );

  mcp.registerTool(
    'vault_list_folder',
    {
      description:
        'List the contents of a vault folder. Returns Obsidian-shaped {files: [...]} where subdirectories are marked with a trailing slash. Not paginated — every entry comes back in one call, so a short list is a short folder, not a first page. Dotfiles are omitted. Empty path lists the root.',
      inputSchema: {
        path: z.string().optional().describe('Vault-relative folder path; empty = root')
      }
    },
    wrap(async ({path}) => {
      const target = path && path.length > 0 ? `/vault/${path.replace(/\/$/, '')}/` : '/vault/';
      return client.getJson(target);
    })
  );

  // ── insight: neighborhood, similar, backlinks ─────────────────────────────
  mcp.registerTool(
    'vault_neighborhood',
    {
      description:
        'Typed-edge BFS from a record. Returns {root_id, depth, direction, via, layers: [{depth, records}], edges} — depth/direction/via echo the effective query, so an empty result is distinguishable from a filter that matched nothing. depth caps at 5. Not paginated: the whole neighborhood comes back in one call.',
      inputSchema: {
        record_id: z.string().min(1),
        depth: z.number().int().min(1).max(5).optional().default(1),
        via: z.array(EDGE_TYPE).optional().describe('Filter to these edge types'),
        direction: z.enum(['outbound', 'inbound', 'both']).optional().default('both')
      }
    },
    wrap(async ({record_id, depth, via, direction}) =>
      client.getJson(`/sections/${encodeURIComponent(record_id)}/neighborhood`, {
        depth,
        via: csv(via),
        direction
      })
    )
  );

  mcp.registerTool(
    'vault_similar',
    {
      description:
        'Embedding-based nearest neighbours of a record. Returns {root_id, k, items: [<record row + distance + score>]} sorted nearest-first — `distance` is cosine distance in [0, 2] (smaller is closer) and `score` is its normalization to [0, 1] as 1 - distance/2, so the two always disagree in direction. Capped by k, NOT paginated: no offset/limit/total, so there is no second page. Self is excluded. Empty items when the record is not yet embedded — that is a pending embed, not an absence of neighbours.',
      inputSchema: {
        record_id: z.string().min(1),
        k: z.number().int().min(1).max(100).optional().default(10)
      }
    },
    wrap(async ({record_id, k}) =>
      client.getJson(`/sections/${encodeURIComponent(record_id)}/similar`, {k})
    )
  );

  mcp.registerTool(
    'vault_backlinks',
    {
      description:
        'List inbound edges to a record, filterable by edge type. Returns the paginated envelope {items, offset, limit, total}, each item {edge: {from_id, to_id, type, weight, note, created}, from_record: <record row + agent_summary>}. Page by items.length, not by the limit you asked for — the server caps limit at 100 and echoes the effective value.',
      inputSchema: {
        record_id: z.string().min(1),
        type: z.array(EDGE_TYPE).optional(),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(20)
      }
    },
    wrap(async ({record_id, type, offset, limit}) =>
      client.getJson(`/sections/${encodeURIComponent(record_id)}/backlinks`, {
        type: csv(type),
        offset,
        limit
      })
    )
  );

  // ── tags ──────────────────────────────────────────────────────────────────
  mcp.registerTool(
    'vault_list_tags',
    {
      description:
        'List the managed tag taxonomy. Returns the paginated envelope {items: [{tag, record_count}], offset, limit, total}; page by items.length (limit caps at 100).',
      inputSchema: {
        prefix: z.string().optional(),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(20)
      }
    },
    wrap(async args => client.getJson('/tags', args))
  );

  mcp.registerTool(
    'vault_tag_info',
    {
      description:
        'Read one taxonomy tag. Returns {tag, description, added, aliases, record_count} where `tag` is always the canonical name. Passing an alias resolves to the canonical row and adds `requested: "<the alias you passed>"` — that extra key is how you detect you were redirected; it is absent when you asked for the canonical name. 404 tag_not_found when the tag is not in the taxonomy.',
      inputSchema: {
        tag: z.string().min(1)
      }
    },
    wrap(async ({tag}) => client.getJson(`/tags/${encodeURIComponent(tag)}`))
  );

  mcp.registerTool(
    'vault_records_by_tag',
    {
      description:
        'List records carrying a tag; aliases resolve to canonical form. Returns {tag, items, offset, limit, total} where `tag` is the canonical name; passing an alias additionally sets `alias_for` and `requested`, which is how you detect the redirect. Items are record rows WITHOUT body, carrying agent_summary + agent_derived_from_hash. Page by items.length (limit caps at 100). 404 tag_not_found when the tag is not in the taxonomy — distinct from a known tag with zero records, which is a 200 with total 0.',
      inputSchema: {
        tag: z.string().min(1),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(20)
      }
    },
    wrap(async ({tag, offset, limit}) =>
      client.getJson(`/tags/${encodeURIComponent(tag)}/records`, {offset, limit})
    )
  );

  // ── suggestions (review queue) ────────────────────────────────────────────
  mcp.registerTool(
    'vault_list_suggestions',
    {
      description:
        'List pending review-queue suggestions. Defaults to status=pending — the common case. `expand: "context"` inlines per-item triage context: record briefs (title/type/status/summary, keyed by record_id, null for deleted records) for every record the payload references, plus taxonomy info for tag kinds — judge a prefetched page instead of fetching per item. Returns the paginated envelope {items, offset, limit, total}, each item {id, kind, subject_id, status, payload, created, resolved_at, resolved_by, claimed_by, claimed_at, claim_expires}. Page by items.length (limit caps at 100).',
      inputSchema: {
        kind: z.array(SUGGESTION_KIND).optional(),
        status: z.array(SUGGESTION_STATUS).optional(),
        subject_id: z.string().optional(),
        expand: z.enum(['context']).optional(),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(20)
      }
    },
    wrap(async args =>
      client.getJson('/suggestions', {
        kind: csv(args.kind),
        status: csv(args.status),
        subject_id: args.subject_id,
        expand: args.expand,
        offset: args.offset,
        limit: args.limit
      })
    )
  );

  mcp.registerTool(
    'vault_read_suggestion',
    {
      description:
        'Read a single suggestion with its full payload (classifier evidence, etc.). Returns the full suggestion row {id, kind, subject_id, status, payload, created, resolved_at, resolved_by, claimed_by, claimed_at, claim_expires}.',
      inputSchema: {id: z.string().min(1)}
    },
    wrap(async ({id}) => client.getJson(`/suggestions/${encodeURIComponent(id)}`))
  );

  mcp.registerTool(
    'vault_suggestions_summary',
    {
      description:
        'Per-kind counts of suggestions in the requested status set (default pending). Returns {statuses, total, by_kind: {[kind]: count}} — `statuses` echoes the effective filter, and kinds with a zero count are absent from by_kind rather than present as 0. Cheap one-shot — surfaced at /vault resume to show review-queue backlog without fetching items.',
      inputSchema: {
        status: z.array(SUGGESTION_STATUS).optional()
      }
    },
    wrap(async args =>
      client.getJson('/suggestions/summary', {
        status: csv(args.status)
      })
    )
  );

  mcp.registerTool(
    'vault_claim_suggestions',
    {
      description:
        'Atomically reserve a batch of pending suggestions of one kind for this triage session (oldest first). Claimed items leave the pending pool; resolving them requires resolved_by = holder until the TTL lapses (expired claims lazily revert to pending, so a crashed holder costs at most the TTL). De-conflicts concurrent same-kind triage agents and overlapping sweeps. Release a claimed item early with vault_reopen_suggestion. `expand: "context"` inlines the same per-item triage context as vault_list_suggestions. Returns {kind, holder, claimed, claim_expires, remaining_pending, items} — `claimed` is how many you actually got (fewer than limit means the queue ran dry), and `remaining_pending` is what is left for other agents.',
      inputSchema: {
        kind: SUGGESTION_KIND,
        holder: z
          .string()
          .min(1)
          .describe('Claim owner label; pass the same value as resolved_by when resolving'),
        limit: z.number().int().min(1).max(100).optional().default(100),
        ttl_seconds: z.number().int().min(60).max(21600).optional().default(1800),
        expand: z.enum(['context']).optional()
      }
    },
    wrap(async ({kind, holder, limit, ttl_seconds, expand}) =>
      client.postJson('/suggestions/claim', {kind, holder, limit, ttl_seconds}, {expand})
    )
  );

  mcp.registerTool(
    'vault_accept_suggestion',
    {
      description:
        'Mark a pending (or own-claimed) suggestion as accepted. The decision is recorded; downstream side-effects (e.g. promoting cites→typed) are handled by separate workflows — or server-side via vault_resolve_suggestions_batch. On a claimed row, resolved_by must equal the claim holder (409 claimed_by_other otherwise). Returns the full suggestion row {id, kind, subject_id, status, payload, created, resolved_at, resolved_by, claimed_by, claimed_at, claim_expires}.',
      inputSchema: {
        id: z.string().min(1),
        resolved_by: z.string().optional()
      }
    },
    wrap(async ({id, resolved_by}) =>
      client.postJson(
        `/suggestions/${encodeURIComponent(id)}/accept`,
        resolved_by ? {resolved_by} : undefined
      )
    )
  );

  mcp.registerTool(
    'vault_reject_suggestion',
    {
      description:
        'Mark a pending (or own-claimed) suggestion as rejected. On a claimed row, resolved_by must equal the claim holder (409 claimed_by_other otherwise). Returns the full suggestion row {id, kind, subject_id, status, payload, created, resolved_at, resolved_by, claimed_by, claimed_at, claim_expires}.',
      inputSchema: {
        id: z.string().min(1),
        resolved_by: z.string().optional()
      }
    },
    wrap(async ({id, resolved_by}) =>
      client.postJson(
        `/suggestions/${encodeURIComponent(id)}/reject`,
        resolved_by ? {resolved_by} : undefined
      )
    )
  );

  mcp.registerTool(
    'vault_resolve_suggestions_batch',
    {
      description:
        'Resolve up to 100 suggestions in one call, with mechanical side effects applied server-side: a tag_suggestion accept realizes the tag on the record FM (settles as tag-realized when the tag is in the taxonomy), a reject strips the candidate from agent.tags_suggested; an edge_type accept requires edge_type (a typed value — "cites is correct" is a reject) and pins the FM edges: override (settles as fm-override). Judgment-bearing kinds (new_tag minting, duplicate merges) resolve status-only. resolved_by doubles as the claim holder for claimed items. Always 200: per-item failures land in results[].error (already_resolved, claimed_by_other, …) and never abort the batch. Returns {accepted, rejected, failed, results} — check `failed` and the per-item results before treating a 200 as a clean drain; a successful item is {id, status, resolved_by, side_effect?}, a failed one {id, error: {code, message}}.',
      inputSchema: {
        resolved_by: z.string().optional(),
        items: z
          .array(
            z.object({
              id: z.string().min(1),
              decision: z.enum(['accept', 'reject']),
              edge_type: EDGE_TYPE.optional().describe(
                'Required for edge_type accepts; must not be "cites"'
              )
            })
          )
          .min(1)
          .max(100)
      }
    },
    wrap(async ({resolved_by, items}) =>
      client.postJson('/suggestions/resolve-batch', resolved_by ? {resolved_by, items} : {items})
    )
  );

  mcp.registerTool(
    'vault_reopen_suggestion',
    {
      description:
        'Move an accepted, rejected, or claimed suggestion back to pending, clearing resolution and claim fields. Escape hatch for misclicks; on a claimed row it is the explicit claim release. 409 when already pending. Returns the full suggestion row {id, kind, subject_id, status, payload, created, resolved_at, resolved_by, claimed_by, claimed_at, claim_expires}.',
      inputSchema: {id: z.string().min(1)}
    },
    wrap(async ({id}) =>
      client.postJson(`/suggestions/${encodeURIComponent(id)}/reopen`, undefined)
    )
  );

  mcp.registerTool(
    'vault_create_suggestion',
    {
      description:
        'File a new pending suggestion from the agent side. Use for kinds the indexer cannot deterministically detect — contradiction_candidate, agent-judged tag_suggestion, etc. No dedup at this layer; agent is responsible for any pre-check via vault_list_suggestions. Responds 201 with the created row {id, kind, subject_id, status, payload, created, …}.',
      inputSchema: {
        kind: SUGGESTION_KIND,
        subject_id: z.string().optional(),
        payload: z.record(z.string(), z.unknown())
      }
    },
    wrap(async args =>
      client.postJson('/suggestions', {
        kind: args.kind,
        subject_id: args.subject_id,
        payload: args.payload
      })
    )
  );

  // ── system ────────────────────────────────────────────────────────────────
  mcp.registerTool(
    'vault_status',
    {
      description:
        'Report server and index state. Returns {ok, schema_version, sqlite_vec_version, vault_data_path, records, edges, pending_suggestions, last_indexed_commit, indexer_running, embedder: {model, retained}, memory: {rss, heap_used, heap_total, external, array_buffers}}. `embedder.retained` says whether the ONNX pipeline is currently resident (it is released after an idle window, so the next embed pays a ~1-3s reload); `memory` is process RSS, useful for watching the embedder arena.',
      inputSchema: {}
    },
    wrap(async () => client.getJson('/system/status'))
  );

  mcp.registerTool(
    'vault_lint',
    {
      description:
        'Run integrity checks (bug-finding, not hygiene) over the vault DB. Nine categories: embedding_hash_drift, records_without_embeddings, orphan_embeddings, orphan_doc_embeddings, orphan_vec_rows, orphan_suggestions, temporal_anomalies (updated < created or future stamps), dangling_tag_aliases, auto_commit_failing. Returns {ok, total_issues, checks: {[name]: {count, samples}}, coverage} — samples are capped at 10 per check, and `coverage.enrichment` carries {total, enriched, unenriched, enrichable_types, by_type, unenriched_records}: the agent-enrichment coverage metric plus `unenriched_records`, a worklist of [{record_id, file_path, type}] that /vault sweep builds its backfill baseline from. Coverage is NOT an integrity check and never contributes to total_issues or flips ok. Cheap (~50ms on a few-thousand-record vault); safe to call from session-start flows like /vault resume.',
      inputSchema: {}
    },
    wrap(async () => client.getJson('/system/lint'))
  );

  mcp.registerTool(
    'vault_resume_bundle',
    {
      description:
        'One-shot session-start bundle for /vault resume: runs the incremental reindex, then returns {reindex, lint (non-zero checks only), suggestions (pending by kind), workflow (agent-workflow Active section + clarify count), logs (most recent, as agent.summary lines), project (the named project’s notes — feedback with full body, the rest as summaries + sizes)}. Replaces the separate reindex/lint/summary/queue/log reads. Note the lint block is a digest, not the vault_lint response: `checks` is pre-filtered to non-zero entries, and coverage arrives flattened as `coverage_enrichment: {total, enriched, unenriched}` without the by_type breakdown or the unenriched_records worklist — call vault_lint when you need those.',
      inputSchema: {
        project: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]*$/)
          .optional()
          .describe('Project name for the project-notes block'),
        logs: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe('Recent session logs to include (default 3)')
      }
    },
    wrap(async ({project, logs}) =>
      client.postJson('/system/resume-bundle', undefined, {project, logs})
    )
  );

  // ── queue items ───────────────────────────────────────────────────────────
  // Backed by the queue_items table — a watcher-maintained derivative of every
  // projects/<name>/queue.md and queue-archive.md. Markdown stays source of
  // truth per constraint C4; the table is the fleet-query surface. See
  // [[topics/project-queue-convention]] for the markdown shape and
  // [[projects/vault-storage/design/queue-items-table]] for schema + identity.
  mcp.registerTool(
    'vault_queue_top',
    {
      description:
        'Top N open queue items across the entire fleet, ordered by (priority DESC, project, section, position). Excludes archive. Default limit 20, max 100. Returns {limit, count, items} — a flat count+items envelope and unpaginated, not the {items, offset, limit, total} shape: there is no offset and no second page, so a truncated result means raise limit. Use case: "what is next across all projects?"',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().default(20)
      }
    },
    wrap(async ({limit}) => client.getJson('/queue/top', {limit}))
  );

  mcp.registerTool(
    'vault_queue_by_section',
    {
      description:
        'All open queue items in one section across the fleet, ordered by (priority DESC, project, position). Returns {section, count, items} — unpaginated; the whole section comes back. Use case: "what is in flight everywhere?" (active), "what is waiting upstream?" (watching), "what is on every project\'s backlog?"',
      inputSchema: {
        section: z.enum(['active', 'backlog', 'watching'])
      }
    },
    wrap(async ({section}) => client.getJson(`/queue/by-section/${encodeURIComponent(section)}`))
  );

  mcp.registerTool(
    'vault_queue_by_priority',
    {
      description:
        'All Backlog items at a specific priority tier across the fleet, ordered by (project, position). Priority is a signed integer centered on 0 — `+2` / `+1` are boosted, `-1` / `-2` are demoted. Returns {priority, count, items} — unpaginated. Use case: "everything we said was priority +2 across all projects".',
      inputSchema: {
        priority: z.number().int()
      }
    },
    wrap(async ({priority}) =>
      client.getJson(`/queue/by-priority/${encodeURIComponent(String(priority))}`)
    )
  );

  mcp.registerTool(
    'vault_queue_by_project',
    {
      description:
        'All open items (Active + Backlog + Watching) for one project, grouped by section in display order: Active first, Backlog by priority DESC, Watching last. Returns {project, count, items} — unpaginated. Use case: "what is on `<project>`\'s queue right now?"',
      inputSchema: {
        project: z.string().min(1).describe('Project slug, e.g. "node-re2"')
      }
    },
    wrap(async ({project}) => client.getJson(`/queue/projects/${encodeURIComponent(project)}`))
  );

  mcp.registerTool(
    'vault_queue_ready',
    {
      description:
        'Backlog items whose blocked-by refs (if any) all resolve to archived items — the "claimable next" view, ordered (priority DESC, project, position). Fleet-wide by default; pass project to scope. Active (already started) and Watching (upstream-gated) are excluded. Unresolved/ambiguous refs BLOCK conservatively — check vault_queue_blocked for the detail. Returns {count, items} — unpaginated, plus a `project` echo when you scoped the call. Use case: "what can I start right now?"',
      inputSchema: {
        project: z.string().min(1).optional().describe('Project slug to scope to, e.g. "node-re2"')
      }
    },
    wrap(async ({project}) => client.getJson('/queue/ready', {project}))
  );

  mcp.registerTool(
    'vault_queue_blocked',
    {
      description:
        'Open queue items with at least one blocking blocked-by ref, each with per-ref resolution detail (state: open | unresolved | ambiguous, plus the resolved target) and an in_cycle flag for mutually-blocked items that can never self-release. The complementary view to vault_queue_ready; unresolved/ambiguous states usually mean a typo\'d ref or a blocker that was renamed. Returns {count, items} — unpaginated, plus a `project` echo when you scoped the call. Each item is a queue row plus `in_cycle` and `blockers: [{ref, state, target?, matches?}]`; `target` is present only once a ref resolves, and `matches` only on an ambiguous ref, where it carries the candidates that made it ambiguous. Use case: "what is stuck, and on what exactly?"',
      inputSchema: {
        project: z.string().min(1).optional().describe('Project slug to scope to, e.g. "node-re2"')
      }
    },
    wrap(async ({project}) => client.getJson('/queue/blocked', {project}))
  );

  mcp.registerTool(
    'vault_queue_project_archive',
    {
      description:
        'Archive slice for one project, ordered by closed_at DESC with undated rows last. Each item carries a regex-inferred close_reason (shipped | rejected | parked | deferred | null). Returns {project, count, items} — unpaginated. Use case: "what did `<project>` ship/reject/park, when?"',
      inputSchema: {
        project: z.string().min(1).describe('Project slug, e.g. "node-re2"')
      }
    },
    wrap(async ({project}) =>
      client.getJson(`/queue/projects/${encodeURIComponent(project)}/archive`)
    )
  );

  mcp.registerTool(
    'vault_queue_reindex',
    {
      description:
        'Walk the vault, re-parse every projects/*/queue.md and queue-archive.md, apply each as a slice, and drop slices for files no longer on disk. The watcher keeps the table in sync on edits; use this for first-run population, missed-event recovery, or after a multi-machine pull where another writer changed queue files. Idempotent. Returns the sweep summary {projectsScanned, filesProcessed, inserted, updated, refreshed, deleted, staleSlicesDropped, errors, durationMs} — `errors` is per-file [{path, message}] and is non-fatal, so check it rather than assuming a 200 means every queue file parsed.',
      inputSchema: {}
    },
    wrap(async () => client.postJson('/maintenance/reindex-queues'))
  );
};
