// Targeted test for the queue_items tool wrappers. Uses a stub McpServer
// that records registerTool calls so we can invoke each handler directly
// and verify the URL / method / params reach the underlying VaultClient.

import test from 'tape-six';
import {VaultClient} from '../src/client.js';
import {registerTools} from '../src/tools.js';

const okJson = body =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: {'Content-Type': 'application/json'}
  });

const makeStubMcp = () => {
  const tools = new Map();
  return {
    tools,
    registerTool(name, _config, handler) {
      tools.set(name, handler);
    }
  };
};

const makeClientWithSpy = onRequest => {
  const fetchImpl = (url, init = {}) => {
    onRequest({url: typeof url === 'string' ? url : url.toString(), init});
    return Promise.resolve(okJson({captured: true}));
  };
  return new VaultClient({apiUrl: 'http://test', apiToken: 'tok', fetchImpl});
};

const setup = () => {
  let captured = null;
  const mcp = makeStubMcp();
  const client = makeClientWithSpy(req => {
    captured = req;
  });
  registerTools(mcp, client);
  return {mcp, getCaptured: () => captured};
};

test('queue tools are registered with vault_queue_* names', t => {
  const {mcp} = setup();
  const names = [
    'vault_queue_top',
    'vault_queue_by_section',
    'vault_queue_by_priority',
    'vault_queue_by_project',
    'vault_queue_project_archive',
    'vault_queue_reindex'
  ];
  for (const name of names) {
    t.ok(mcp.tools.has(name), `${name} registered`);
  }
});

test('vault_queue_top → GET /queue/top with limit', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_queue_top')({limit: 5});
  const {url, init} = getCaptured();
  t.equal(init.method, 'GET');
  t.ok(url.startsWith('http://test/queue/top'), 'url path');
  t.ok(url.includes('limit=5'), 'limit serialised');
});

test('vault_queue_by_section → GET /queue/by-section/{section}', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_queue_by_section')({section: 'backlog'});
  const {url, init} = getCaptured();
  t.equal(init.method, 'GET');
  t.equal(url, 'http://test/queue/by-section/backlog');
});

test('vault_queue_by_priority → GET /queue/by-priority/{n} (negative ok)', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_queue_by_priority')({priority: -1});
  const {url} = getCaptured();
  t.equal(url, 'http://test/queue/by-priority/-1');
});

test('vault_queue_by_project → GET /queue/projects/{name}', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_queue_by_project')({project: 'node-re2'});
  const {url} = getCaptured();
  t.equal(url, 'http://test/queue/projects/node-re2');
});

test('vault_queue_project_archive → GET /queue/projects/{name}/archive', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_queue_project_archive')({project: 'node-re2'});
  const {url} = getCaptured();
  t.equal(url, 'http://test/queue/projects/node-re2/archive');
});

test('vault_queue_reindex → POST /maintenance/reindex-queues (no body)', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_queue_reindex')({});
  const {url, init} = getCaptured();
  t.equal(init.method, 'POST');
  t.equal(url, 'http://test/maintenance/reindex-queues');
});

test('project slugs with slashes/spaces are URL-encoded', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_queue_by_project')({project: 'weird name/with/slash'});
  const {url} = getCaptured();
  t.equal(url, 'http://test/queue/projects/weird%20name%2Fwith%2Fslash');
});
