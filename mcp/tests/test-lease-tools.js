// Targeted tests for the lease tool wrappers (agent-coordination protocol).
// Stub McpServer records registerTool calls; a fetch spy verifies the URL /
// method / body each handler sends.

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

const setup = () => {
  let captured = null;
  const fetchImpl = (url, init = {}) => {
    captured = {url: typeof url === 'string' ? url : url.toString(), init};
    return Promise.resolve(okJson({captured: true}));
  };
  const mcp = makeStubMcp();
  registerTools(mcp, new VaultClient({apiUrl: 'http://test', apiToken: 'tok', fetchImpl}));
  return {mcp, getCaptured: () => captured};
};

test('lease tools are registered with vault_lease_* names', t => {
  const {mcp} = setup();
  for (const name of [
    'vault_lease_list',
    'vault_lease_events',
    'vault_lease_claim',
    'vault_lease_renew',
    'vault_lease_release',
    'vault_lease_transfer'
  ]) {
    t.ok(mcp.tools.has(name), `${name} registered`);
  }
});

test('vault_lease_list → GET /leases, resource filter as query', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_lease_list')({});
  t.ok(getCaptured().url.endsWith('/leases'), 'bare list has no query');
  await mcp.tools.get('vault_lease_list')({resource: 'repo:github.com/uhop/deep6'});
  t.ok(
    getCaptured().url.includes('/leases?resource=repo%3Agithub.com%2Fuhop%2Fdeep6'),
    'resource filter is URL-encoded'
  );
});

test('vault_lease_claim → POST /leases/claim with body', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_lease_claim')({
    resource: 'repo:github.com/uhop/deep6',
    holder: 'nuke/session-a',
    kind: 'agent',
    priority: 'cwd'
  });
  const {url, init} = getCaptured();
  t.ok(url.endsWith('/leases/claim'));
  t.equal(init.method, 'POST');
  const body = JSON.parse(init.body);
  t.equal(body.resource, 'repo:github.com/uhop/deep6');
  t.equal(body.priority, 'cwd');
  t.equal(body.kind, undefined, 'default agent kind is not sent');
});

test('vault_lease_claim sends human kind explicitly', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_lease_claim')({resource: 'repo:x', holder: 'eugene', kind: 'human'});
  const body = JSON.parse(getCaptured().init.body);
  t.equal(body.kind, 'human');
  t.equal(body.priority, undefined, 'no priority for humans');
});

test('vault_lease_transfer → POST /leases/transfer', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_lease_transfer')({
    resource: 'repo:x',
    holder: 'nuke/session-a',
    to_holder: 'eugene',
    to_kind: 'human'
  });
  const {url, init} = getCaptured();
  t.ok(url.endsWith('/leases/transfer'));
  const body = JSON.parse(init.body);
  t.equal(body.to_holder, 'eugene');
  t.equal(body.to_kind, 'human');
});

test('vault_lease_release and renew → POST with holder', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_lease_release')({resource: 'repo:x', holder: 'h', force: true});
  t.equal(JSON.parse(getCaptured().init.body).force, true);
  await mcp.tools.get('vault_lease_renew')({resource: 'repo:x', holder: 'h', ttl_seconds: 7200});
  t.equal(JSON.parse(getCaptured().init.body).ttl_seconds, 7200);
});
