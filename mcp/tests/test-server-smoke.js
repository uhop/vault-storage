import test from 'tape-six';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {VaultClient} from '../src/client.js';
import {registerResources} from '../src/resources.js';
import {registerTools} from '../src/tools.js';

const noopFetch = () => Promise.resolve(new Response('{}'));

const makeClient = () =>
  new VaultClient({apiUrl: 'http://test', apiToken: 'tok', fetchImpl: noopFetch});

test('registerTools runs without throwing', t => {
  const mcp = new McpServer({name: 'test', version: '0.0.0'}, {capabilities: {tools: {}}});
  registerTools(mcp, makeClient());
  t.pass('all tools registered');
});

test('registerResources runs without throwing', t => {
  const mcp = new McpServer({name: 'test', version: '0.0.0'}, {capabilities: {resources: {}}});
  registerResources(mcp, makeClient());
  t.pass('all resources registered');
});

test('full registration (tools + resources) succeeds', t => {
  const mcp = new McpServer(
    {name: 'test', version: '0.0.0'},
    {capabilities: {tools: {}, resources: {}}}
  );
  const c = makeClient();
  registerTools(mcp, c);
  registerResources(mcp, c);
  t.pass('combined registration is clean');
});
