// Targeted tests for the handoff tool wrappers (agent-coordination leg 2).
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

test('handoff tools are registered with vault_handoff_* names', t => {
  const {mcp} = setup();
  for (const name of [
    'vault_handoff_list',
    'vault_handoff_get',
    'vault_handoff_events',
    'vault_handoff_create',
    'vault_handoff_claim',
    'vault_handoff_resolve',
    'vault_handoff_resubmit',
    'vault_handoff_note'
  ]) {
    t.ok(mcp.tools.has(name), `${name} registered`);
  }
});

test('vault_handoff_list → GET /handoffs, filters as query', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_handoff_list')({});
  t.ok(getCaptured().url.endsWith('/handoffs'), 'bare list has no query');
  await mcp.tools.get('vault_handoff_list')({
    to: 'repo:github.com/uhop/deep6',
    status: 'open'
  });
  const url = getCaptured().url;
  t.ok(url.includes('to=repo%3Agithub.com%2Fuhop%2Fdeep6'), 'role filter is URL-encoded');
  t.ok(url.includes('status=open'), 'status filter rides the query');
});

test('vault_handoff_get → GET /handoffs/{id}, id URL-encoded', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_handoff_get')({id: 'abc-123'});
  t.ok(getCaptured().url.endsWith('/handoffs/abc-123'));
});

test('vault_handoff_events → GET /handoffs/events with id + limit', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_handoff_events')({id: 'abc-123', limit: 25});
  const url = getCaptured().url;
  t.ok(url.includes('/handoffs/events?'));
  t.ok(url.includes('id=abc-123'));
  t.ok(url.includes('limit=25'));
});

test('vault_handoff_create → POST /handoffs with the full request', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_handoff_create')({
    idempotency_key: 'k-1',
    project: 'deep6',
    to: 'repo:github.com/uhop/deep6',
    kind: 'review-branch',
    ref: {type: 'branch', value: 'topic-x'},
    from: {host: 'mba', session: 's-1'},
    body: 'Please review.'
  });
  const {url, init} = getCaptured();
  t.ok(url.endsWith('/handoffs'));
  t.equal(init.method, 'POST');
  const body = JSON.parse(init.body);
  t.equal(body.idempotency_key, 'k-1', 'idempotency key always sent');
  t.equal(body.to, 'repo:github.com/uhop/deep6');
  t.equal(body.ref.value, 'topic-x');
  t.equal(body.from.host, 'mba');
});

test('vault_handoff_claim → POST /handoffs/claim', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_handoff_claim')({id: 'h-1', holder: 'nuke/owner', ttl_seconds: 3600});
  const {url, init} = getCaptured();
  t.ok(url.endsWith('/handoffs/claim'));
  const body = JSON.parse(init.body);
  t.equal(body.id, 'h-1');
  t.equal(body.holder, 'nuke/owner');
  t.equal(body.ttl_seconds, 3600);
});

test('vault_handoff_resolve → POST /handoffs/resolve carrying verdict + note', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_handoff_resolve')({
    id: 'h-1',
    holder: 'nuke/owner',
    resolution: 'returned',
    note: 'Missing tests.'
  });
  const body = JSON.parse(getCaptured().init.body);
  t.equal(body.resolution, 'returned');
  t.equal(body.note, 'Missing tests.');
  t.equal(body.result, undefined, 'no result on returned');
});

test('vault_handoff_resubmit and note → POST with their payloads', async t => {
  const {mcp, getCaptured} = setup();
  await mcp.tools.get('vault_handoff_resubmit')({
    id: 'h-1',
    ref: {type: 'branch', value: 'topic-x-v2'}
  });
  t.ok(getCaptured().url.endsWith('/handoffs/resubmit'));
  t.equal(JSON.parse(getCaptured().init.body).ref.value, 'topic-x-v2');

  await mcp.tools.get('vault_handoff_note')({id: 'h-1', author: 'mba/s-1', text: 'rebased'});
  t.ok(getCaptured().url.endsWith('/handoffs/note'));
  t.equal(JSON.parse(getCaptured().init.body).text, 'rebased');
});
