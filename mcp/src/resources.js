// MCP resources: read-only reference content the agent can fetch by URI.
// Three primary surfaces: live status, the pending review queue, and the
// managed tag taxonomy. All proxy to the REST API.

import {VaultClientError} from './client.js';

const RESOURCE_DEFS = [
  {
    name: 'vault-status',
    uri: 'vault://status',
    title: 'Vault status',
    description:
      'Indexer state, schema version, record/edge/suggestion counts, last_indexed_commit. ' +
      'Cheap to refresh; useful at session start and after structural changes.',
    fetch: c => c.getJson('/system/status')
  },
  {
    name: 'vault-suggestions-pending',
    uri: 'vault://suggestions/pending',
    title: 'Pending suggestions',
    description:
      'All pending review-queue items. Use this for bulk read; for filtered reads call vault_list_suggestions.',
    fetch: c => c.getJson('/suggestions', {status: 'pending', limit: 100})
  },
  {
    name: 'vault-tags-taxonomy',
    uri: 'vault://taxonomy/tags',
    title: 'Tag taxonomy',
    description: 'Current managed tag list with per-tag record_count. Sorted by count DESC.',
    fetch: c => c.getJson('/tags', {limit: 100})
  }
];

export const registerResources = (mcp, client) => {
  for (const def of RESOURCE_DEFS) {
    mcp.registerResource(
      def.name,
      def.uri,
      {title: def.title, description: def.description, mimeType: 'application/json'},
      async uri => {
        try {
          const value = await def.fetch(client);
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify(value, null, 2)
              }
            ]
          };
        } catch (err) {
          if (err instanceof VaultClientError) {
            return {
              contents: [
                {
                  uri: uri.href,
                  mimeType: 'application/json',
                  text: JSON.stringify(
                    {error: err.message, code: err.code, status: err.status},
                    null,
                    2
                  )
                }
              ]
            };
          }
          throw err;
        }
      }
    );
  }
};
