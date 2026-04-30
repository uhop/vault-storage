#!/usr/bin/env node
// vault-storage-mcp — MCP adapter for the vault-storage REST API.
//
// Reads VAULT_API_URL and VAULT_API_TOKEN from the environment (set in the
// MCP client config), connects to the REST server, and exposes ~20 tools and
// 3 resources to the agent. Pure protocol adapter — no local state.

import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {clientFromEnv} from './client.js';
import {registerResources} from './resources.js';
import {registerTools} from './tools.js';

const PACKAGE_NAME = 'vault-storage-mcp';
const PACKAGE_VERSION = '0.0.2';

const main = async () => {
  const client = clientFromEnv();
  const mcp = new McpServer(
    {name: PACKAGE_NAME, version: PACKAGE_VERSION},
    {capabilities: {tools: {}, resources: {}}}
  );

  registerTools(mcp, client);
  registerResources(mcp, client);

  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  // The transport keeps the process alive while connected. Surface a clean
  // exit on transport close so npm/npx wrappers don't see a hanging process.
  transport.onclose = () => {
    process.exit(0);
  };
};

main().catch(err => {
  process.stderr.write(`vault-storage-mcp: fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
