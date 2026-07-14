// Targeted test for the claim / resolve-batch tool wrappers (schema 15
// server surface). Stub McpServer + fetch spy, same shape as
// test-queue-tools.js: invoke each handler directly and verify the URL /
// method / body that reach the VaultClient.

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
  const mcp = makeStubMcp();
  const client = new VaultClient({
    apiUrl: 'http://test',
    apiToken: 'tok',
    fetchImpl: (url, init = {}) => {
      captured = {url: typeof url === 'string' ? url : url.toString(), init};
      return Promise.resolve(okJson({captured: true}));
    }
  });
  registerTools(mcp, client);
  return {mcp, getCaptured: () => captured};
};

test('claim / resolve-batch tools are registered', t => {
  const {mcp} = setup();
  t.ok(mcp.tools.has('vault_claim_suggestions'), 'vault_claim_suggestions registered');
  t.ok(
    mcp.tools.has('vault_resolve_suggestions_batch'),
    'vault_resolve_suggestions_batch registered'
  );
});

test('vault_claim_suggestions → POST /suggestions/claim with body + expand query', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_claim_suggestions')({
    kind: 'tag_suggestion',
    holder: 'sweep-A',
    limit: 50,
    ttl_seconds: 600,
    expand: 'context'
  });
  const {url, init} = getCaptured();
  t.equal(init.method, 'POST');
  t.ok(url.startsWith('http://test/suggestions/claim'), 'url path');
  t.ok(url.includes('expand=context'), 'expand serialised as query');
  const body = JSON.parse(init.body);
  t.equal(body.kind, 'tag_suggestion');
  t.equal(body.holder, 'sweep-A');
  t.equal(body.limit, 50);
  t.equal(body.ttl_seconds, 600);
});

test('vault_resolve_suggestions_batch → POST /suggestions/resolve-batch', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_resolve_suggestions_batch')({
    resolved_by: 'sweep-A',
    items: [
      {id: 'a', decision: 'accept', edge_type: 'applies-to'},
      {id: 'b', decision: 'reject'}
    ]
  });
  const {url, init} = getCaptured();
  t.equal(init.method, 'POST');
  t.equal(url, 'http://test/suggestions/resolve-batch');
  const body = JSON.parse(init.body);
  t.equal(body.resolved_by, 'sweep-A');
  t.equal(body.items.length, 2);
  t.equal(body.items[0].edge_type, 'applies-to');
});

test('vault_resolve_suggestions_batch omits resolved_by when unset', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_resolve_suggestions_batch')({
    items: [{id: 'a', decision: 'reject'}]
  });
  const body = JSON.parse(getCaptured().init.body);
  t.notOk('resolved_by' in body, 'resolved_by absent');
  t.equal(body.items.length, 1);
});
