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

const SUGGESTION_STATUS = z.enum(['pending', 'accepted', 'rejected']);

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
        'List records (atomized pieces or whole-file records) with filters. Returns a paginated envelope.',
      inputSchema: {
        type: z.array(RECORD_TYPE).optional(),
        status: z.array(RECORD_STATUS).optional(),
        file_prefix: z.string().optional().describe('Vault-relative path prefix'),
        priority_min: z.number().int().optional(),
        priority_max: z.number().int().optional(),
        updated_since: z.string().optional().describe('ISO date'),
        sort: z
          .enum([
            'priority',
            'created',
            'updated',
            'last_referenced',
            'decay_score',
            'file_path'
          ])
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
      description: 'Read frontmatter-only projection of a record (cheap fetch, no body).',
      inputSchema: {record_id: z.string().min(1)}
    },
    wrap(async ({record_id}) =>
      client.getJson(`/sections/${encodeURIComponent(record_id)}/meta`)
    )
  );

  mcp.registerTool(
    'vault_update_piece',
    {
      description:
        'Replace a record body via /sections/{id} PUT. Body is full markdown (frontmatter optional; user-authored keys are merged; `created`/`updated` are silently overridden by the indexer; DB-only keys like `record_id`/`content_hash` are rejected).',
      inputSchema: {
        record_id: z.string().min(1),
        markdown: z.string().describe('Full markdown content (frontmatter optional)')
      }
    },
    wrap(async ({record_id, markdown}) => {
      await client.putText(`/sections/${encodeURIComponent(record_id)}`, markdown);
      return {ok: true, record_id};
    })
  );

  // ── files (path-based) ────────────────────────────────────────────────────
  mcp.registerTool(
    'vault_read_file',
    {
      description:
        'Read a file by vault-relative path. Returns the markdown source. For atomized folders, the path can be the original `<stem>.md` and the server composes pieces back into one document.',
      inputSchema: {path: z.string().min(1)}
    },
    wrap(async ({path}) => client.getText(`/vault/${path}`))
  );

  mcp.registerTool(
    'vault_write_file',
    {
      description:
        'Create or replace a file at a vault-relative path. Body is full markdown. `created`/`updated` are silently overridden by the indexer; DB-only frontmatter keys (`record_id`, `content_hash`, `last_referenced`, `decay_score`) are rejected.',
      inputSchema: {
        path: z.string().min(1).describe('Vault-relative path; must end with .md'),
        markdown: z.string()
      }
    },
    wrap(async ({path, markdown}) => {
      await client.putText(`/vault/${path}`, markdown);
      return {ok: true, path};
    })
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
        'List the contents of a vault folder. Returns Obsidian-shaped {files: [...]} where subdirectories are marked with a trailing slash. Empty path lists the root.',
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
        'Typed-edge BFS from a record. Returns {root_id, layers: [{depth, records}], edges}. depth caps at 5.',
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
        'Embedding-based nearest neighbours of a record. Self is excluded. Empty when not yet embedded.',
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
        'List inbound edges to a record. Each item: {edge, from_record}. Filterable by edge type.',
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
      description: 'List managed tag taxonomy with per-tag record_count.',
      inputSchema: {
        prefix: z.string().optional(),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(20)
      }
    },
    wrap(async args => client.getJson('/tags', args))
  );

  mcp.registerTool(
    'vault_records_by_tag',
    {
      description: 'List records carrying a tag. Aliases are resolved to canonical form.',
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
        'List pending review-queue suggestions. Defaults to status=pending — the common case.',
      inputSchema: {
        kind: z.array(SUGGESTION_KIND).optional(),
        status: z.array(SUGGESTION_STATUS).optional(),
        subject_id: z.string().optional(),
        offset: z.number().int().min(0).optional().default(0),
        limit: z.number().int().min(1).max(100).optional().default(20)
      }
    },
    wrap(async args =>
      client.getJson('/suggestions', {
        kind: csv(args.kind),
        status: csv(args.status),
        subject_id: args.subject_id,
        offset: args.offset,
        limit: args.limit
      })
    )
  );

  mcp.registerTool(
    'vault_read_suggestion',
    {
      description: 'Read a single suggestion with its full payload (classifier evidence, etc.).',
      inputSchema: {id: z.string().min(1)}
    },
    wrap(async ({id}) => client.getJson(`/suggestions/${encodeURIComponent(id)}`))
  );

  mcp.registerTool(
    'vault_suggestions_summary',
    {
      description:
        'Per-kind counts of suggestions in the requested status set (default pending). Cheap one-shot — surfaced at /vault resume to show review-queue backlog without fetching items.',
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
    'vault_accept_suggestion',
    {
      description:
        'Mark a pending suggestion as accepted. The decision is recorded; downstream side-effects (e.g. promoting cites→typed) are handled by separate workflows.',
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
      description: 'Mark a pending suggestion as rejected.',
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
    'vault_reopen_suggestion',
    {
      description:
        'Move an accepted/rejected suggestion back to pending and clear resolved_at/resolved_by. Escape hatch for misclicks. 409 when already pending.',
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
        'File a new pending suggestion from the agent side. Use for kinds the indexer cannot deterministically detect — contradiction_candidate, agent-judged tag_suggestion, etc. No dedup at this layer; agent is responsible for any pre-check via vault_list_suggestions.',
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

  // ── sync from Obsidian ────────────────────────────────────────────────────
  mcp.registerTool(
    'vault_sync_from_obsidian',
    {
      description:
        'Run an incremental Obsidian → vault-data sync (cutover bridge). Local edits in vault-data are detected and skipped. Use dry_run=true to preview without writing.',
      inputSchema: {
        source_path: z.string().optional().describe('Obsidian source path (server-side absolute)'),
        dry_run: z.boolean().optional().default(false),
        write_log: z.boolean().optional().default(true)
      }
    },
    wrap(async ({source_path, dry_run, write_log}) =>
      client.postJson('/sync/from-obsidian', {source_path, dry_run, write_log})
    )
  );

  // ── system ────────────────────────────────────────────────────────────────
  mcp.registerTool(
    'vault_status',
    {
      description:
        'Report indexer state, schema version, record/edge/suggestion counts, and last_indexed_commit.',
      inputSchema: {}
    },
    wrap(async () => client.getJson('/system/status'))
  );

  mcp.registerTool(
    'vault_lint',
    {
      description:
        'Run integrity checks (bug-finding, not hygiene) over the vault DB. Categories: embedding hash drift, records without embeddings, orphan embeddings, temporal anomalies (updated < created or future stamps), dangling tag aliases. Returns {ok, total_issues, checks: {[name]: {count, samples}}}; samples are capped at 10 per check. Cheap (~50ms on a few-thousand-record vault); safe to call from session-start flows like /vault resume.',
      inputSchema: {}
    },
    wrap(async () => client.getJson('/system/lint'))
  );
};
