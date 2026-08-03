// Tests for the narrow-blast-radius write tools (vault_append, vault_replace,
// vault_patch_fm) and the ETag plumbing that lets an MCP read seed a
// conditional write. Same stub-McpServer shape as test-queue-tools.js: invoke
// each handler directly and assert on what reached the VaultClient.

import test from 'tape-six';
import {VaultClient} from '../src/client.js';
import {registerTools} from '../src/tools.js';

const makeStubMcp = () => {
  const tools = new Map();
  return {
    tools,
    registerTool(name, config, handler) {
      tools.set(name, {config, handler});
    }
  };
};

const setup = (respond = () => new Response('{}', {status: 200})) => {
  let captured = null;
  const fetchImpl = (url, init = {}) => {
    captured = {url: typeof url === 'string' ? url : url.toString(), init};
    return Promise.resolve(respond(captured));
  };
  const mcp = makeStubMcp();
  registerTools(mcp, new VaultClient({apiUrl: 'http://test', apiToken: 'tok', fetchImpl}));
  return {
    call: (name, args) => mcp.tools.get(name).handler(args),
    tool: name => mcp.tools.get(name),
    getCaptured: () => captured
  };
};

const bodyOf = captured => JSON.parse(captured.init.body);

const firstText = result => result.content[0].text;

test('the safe write tools are registered', t => {
  const {tool} = setup();
  for (const name of ['vault_append', 'vault_replace', 'vault_patch_fm']) {
    t.ok(tool(name), `${name} registered`);
  }
});

test('vault_append → POST /vault/edit with op=append', async t => {
  const {call, getCaptured} = setup();
  await call('vault_append', {path: 'projects/x/queue.md', text: '- new item\n'});
  const captured = getCaptured();
  t.equal(captured.init.method, 'POST');
  t.equal(captured.url, 'http://test/vault/edit');
  t.deepEqual(bodyOf(captured), {
    path: 'projects/x/queue.md',
    op: 'append',
    text: '- new item\n'
  });
});

test('vault_replace → POST /vault/edit with op=replace, all omitted unless set', async t => {
  const {call, getCaptured} = setup();
  await call('vault_replace', {path: 'a.md', from: 'old', to: 'new'});
  t.deepEqual(bodyOf(getCaptured()), {path: 'a.md', op: 'replace', from: 'old', to: 'new'});

  await call('vault_replace', {path: 'a.md', from: 'old', to: 'new', all: true});
  t.deepEqual(bodyOf(getCaptured()), {
    path: 'a.md',
    op: 'replace',
    from: 'old',
    to: 'new',
    all: true
  });

  // An empty `to` is a deletion, not a missing argument — it must survive.
  await call('vault_replace', {path: 'a.md', from: 'old', to: ''});
  t.equal(bodyOf(getCaptured()).to, '', 'empty replacement preserved');
});

test('vault_replace surfaces a failed assert as an error result', async t => {
  const {call} = setup(
    () =>
      new Response(
        JSON.stringify({
          error: 'replace target not found in a.md',
          code: 'replace_assert_failed',
          details: {occurrences: 0}
        }),
        {status: 409, headers: {'Content-Type': 'application/json'}}
      )
  );
  const result = await call('vault_replace', {path: 'a.md', from: 'nope', to: 'x'});
  t.ok(result.isError, 'flagged as an error result');
  const payload = JSON.parse(firstText(result));
  t.equal(payload.code, 'replace_assert_failed', 'server code preserved');
  t.equal(payload.status, 409);
});

test('vault_patch_fm → PATCH /sections/{id}/fm with the ops array', async t => {
  const {call, getCaptured} = setup(
    () =>
      new Response(JSON.stringify({changed: true, results: []}), {
        status: 200,
        headers: {'Content-Type': 'application/json'}
      })
  );
  const ops = [{op: 'add', path: '/related', value: '[[topics/foo]]'}];
  const result = await call('vault_patch_fm', {record_id: 'rec 1/x', ops});
  const captured = getCaptured();
  t.equal(captured.init.method, 'PATCH');
  t.equal(captured.url, 'http://test/sections/rec%201%2Fx/fm', 'record id URL-encoded');
  t.deepEqual(bodyOf(captured), {ops});
  t.equal(JSON.parse(firstText(result)).changed, true, 'server response passed through');
});

test('vault_read_file returns bare markdown by default', async t => {
  const {call, getCaptured} = setup(
    () =>
      new Response('---\ntitle: A\n---\nbody\n', {
        status: 200,
        headers: {'Content-Type': 'text/markdown', ETag: '"abc123"'}
      })
  );
  const result = await call('vault_read_file', {path: 'topics/a.md'});
  t.equal(getCaptured().init.method, 'GET');
  t.equal(firstText(result), '---\ntitle: A\n---\nbody\n', 'markdown verbatim, not JSON-wrapped');
});

test('vault_read_file include_etag returns the envelope with the tag', async t => {
  const {call} = setup(
    () =>
      new Response('---\ntitle: A\n---\nbody\n', {
        status: 200,
        headers: {'Content-Type': 'text/markdown', ETag: '"abc123"'}
      })
  );
  const payload = JSON.parse(
    firstText(await call('vault_read_file', {path: 'a.md', include_etag: true}))
  );
  t.equal(payload.etag, '"abc123"', 'etag surfaced');
  t.equal(payload.composed, false, 'flat file is not composed');
  t.equal(payload.content, '---\ntitle: A\n---\nbody\n');
  t.equal(payload.path, 'a.md');
});

test('vault_read_file include_etag flags a composed folder view', async t => {
  const {call} = setup(
    () =>
      new Response('composed\n', {
        status: 200,
        headers: {'Content-Type': 'text/markdown', ETag: 'W/"abc123"', 'X-Vault-Composed': 'true'}
      })
  );
  const payload = JSON.parse(
    firstText(await call('vault_read_file', {path: 'a.md', include_etag: true}))
  );
  t.equal(payload.composed, true, 'composed view flagged so the caller edits pieces instead');
});

test('vault_write_file sends If-Match only when expected_etag is given', async t => {
  const {call, getCaptured} = setup(
    () => new Response(null, {status: 204, headers: {ETag: '"new"'}})
  );

  await call('vault_write_file', {path: 'a.md', frontmatter: {title: 'A'}, body: 'x'});
  t.equal(getCaptured().init.headers['If-Match'], undefined, 'unconditional by default');

  const result = await call('vault_write_file', {
    path: 'a.md',
    frontmatter: {title: 'A'},
    body: 'x',
    expected_etag: '"abc123"'
  });
  const captured = getCaptured();
  t.equal(captured.init.method, 'PUT');
  t.equal(captured.init.headers['If-Match'], '"abc123"', 'expected_etag becomes If-Match');
  t.deepEqual(bodyOf(captured), {frontmatter: {title: 'A'}, body: 'x'});
  t.equal(JSON.parse(firstText(result)).etag, '"new"', 'new etag returned for chaining');
});

test('vault_write_file surfaces a 412 as a precondition_failed error result', async t => {
  const {call} = setup(
    () =>
      new Response(
        JSON.stringify({
          error: 'If-Match precondition failed',
          code: 'precondition_failed',
          details: {current_etag: 'def456'}
        }),
        {status: 412, headers: {'Content-Type': 'application/json'}}
      )
  );
  const result = await call('vault_write_file', {
    path: 'a.md',
    frontmatter: {},
    body: 'x',
    expected_etag: '"stale"'
  });
  t.ok(result.isError, 'flagged as an error result');
  const payload = JSON.parse(firstText(result));
  t.equal(payload.code, 'precondition_failed');
  t.equal(payload.details.current_etag, 'def456', 'current etag reaches the caller for the retry');
});

test('vault_update_piece accepts expected_etag too', async t => {
  const {call, getCaptured} = setup(
    () => new Response(null, {status: 204, headers: {ETag: '"n"'}})
  );
  await call('vault_update_piece', {
    record_id: 'r1',
    frontmatter: {},
    body: 'x',
    expected_etag: '"e"'
  });
  const captured = getCaptured();
  t.equal(captured.url, 'http://test/sections/r1');
  t.equal(captured.init.headers['If-Match'], '"e"');
});
