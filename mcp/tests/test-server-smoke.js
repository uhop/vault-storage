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

test('strictInputs refuses an undeclared tool argument by name', async t => {
  const {Client} = await import('@modelcontextprotocol/sdk/client/index.js');
  const {InMemoryTransport} = await import('@modelcontextprotocol/sdk/inMemory.js');
  const {strictInputs} = await import('../src/tools.js');
  const requests = [];
  const client = new VaultClient({
    apiUrl: 'http://test',
    apiToken: 'tok',
    fetchImpl: (url, init) => {
      requests.push({url: String(url), body: init?.body});
      return Promise.resolve(
        new Response('{"path":"a.md","etag":"e"}', {headers: {'Content-Type': 'application/json'}})
      );
    }
  });
  const mcp = new McpServer({name: 'test', version: '0.0.0'}, {capabilities: {tools: {}}});
  registerTools(strictInputs(mcp), client);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await mcp.connect(serverSide);
  const agent = new Client({name: 'test-client', version: '0.0.0'});
  await agent.connect(clientSide);
  try {
    const refused = await agent.callTool({
      name: 'vault_search',
      arguments: {query: 'x', agent: {}}
    });
    t.ok(refused.isError, 'an undeclared argument is an error');
    t.matchString(refused.content[0].text, /unknown argument\(s\): agent; accepted: /, 'names it');
    t.equal(requests.length, 0, 'nothing reached the server');

    const {tools} = await agent.listTools();
    const search = tools.find(tool => tool.name === 'vault_search');
    t.equal(search.inputSchema.additionalProperties, false, 'the schema advertises strictness');

    const ok = await agent.callTool({name: 'vault_append', arguments: {path: 'a.md', text: 'x'}});
    t.notOk(ok.isError, 'declared arguments still pass');
    t.equal(requests.length, 1, 'and reach the server');
  } finally {
    await agent.close();
    await mcp.close();
  }
});
