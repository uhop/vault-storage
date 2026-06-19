import test from 'tape-six';
import {VaultClient, VaultClientError} from '../src/client.js';

const fakeFetch =
  responder =>
  (url, init = {}) => {
    const result = responder(typeof url === 'string' ? url : url.toString(), init);
    return Promise.resolve(result);
  };

const ok = (body, status = 200, contentType = 'application/json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {'Content-Type': contentType}
  });

const err = (body, status) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'}
  });

const makeClient = responder =>
  new VaultClient({apiUrl: 'http://test', apiToken: 'tok', fetchImpl: fakeFetch(responder)});

test('VaultClient: getJson sends Bearer token and parses JSON', async t => {
  let seenAuth = null;
  const c = makeClient((url, init) => {
    seenAuth = init.headers['Authorization'] ?? null;
    t.equal(url, 'http://test/system/status', 'request URL is correct');
    return ok({records: 7});
  });
  const body = await c.getJson('/system/status');
  t.equal(seenAuth, 'Bearer tok', 'Authorization header set');
  t.equal(body.records, 7, 'JSON parsed');
});

test('VaultClient: getJson encodes query params', async t => {
  const c = makeClient(url => {
    t.ok(url.includes('limit=20'), 'limit serialised');
    t.ok(url.includes('mode=semantic'), 'mode serialised');
    return ok([]);
  });
  await c.getJson('/search/simple/', {limit: 20, mode: 'semantic'});
});

test('VaultClient: HTTP 404 throws VaultClientError with code=not_found', async t => {
  const c = makeClient(() => err({error: 'no such record', code: 'record_not_found'}, 404));
  try {
    await c.getJson('/sections/abc');
    t.fail('expected throw');
  } catch (e) {
    t.ok(e instanceof VaultClientError, 'throws VaultClientError');
    t.equal(e.status, 404, 'status preserved');
    t.equal(e.code, 'record_not_found', 'code from server body');
    t.equal(e.message, 'no such record', 'message from server body');
  }
});

test('VaultClient: 401 maps to auth_failed when server omits code', async t => {
  const c = makeClient(() => err({error: 'unauthorized'}, 401));
  try {
    await c.getJson('/anything');
    t.fail('expected throw');
  } catch (e) {
    t.equal(e.code, 'auth_failed', 'derived code');
  }
});

test('VaultClient: network error wraps to code=network', async t => {
  const c = makeClient(() => Promise.reject(new Error('ECONNREFUSED')));
  try {
    await c.getJson('/anything');
    t.fail('expected throw');
  } catch (e) {
    t.equal(e.code, 'network', 'network code');
    t.ok(e.message.includes('ECONNREFUSED'), 'message preserved');
  }
});

test('VaultClient: putJson sends application/json and returns void on 204', async t => {
  let seenContentType = null;
  let seenBody;
  const c = makeClient((_url, init) => {
    seenContentType = init.headers['Content-Type'] ?? null;
    seenBody = init.body;
    return new Response(null, {status: 204});
  });
  await c.putJson('/vault/topics/x.md', {frontmatter: {title: 'X'}, body: '## body'});
  t.equal(seenContentType, 'application/json', 'Content-Type=application/json');
  t.equal(
    seenBody,
    JSON.stringify({frontmatter: {title: 'X'}, body: '## body'}),
    'body serialized'
  );
});

test('VaultClient: postJson serializes body and returns parsed response', async t => {
  let seenBody;
  let seenContentType = null;
  const c = makeClient((_url, init) => {
    seenBody = init.body;
    seenContentType = init.headers['Content-Type'] ?? null;
    return ok({ok: true});
  });
  const r = await c.postJson('/maintenance/run-all', {dry_run: true});
  t.equal(seenContentType, 'application/json', 'Content-Type=application/json');
  t.equal(seenBody, JSON.stringify({dry_run: true}), 'body JSON-encoded');
  t.equal(r.ok, true, 'response parsed');
});

test('VaultClient: deletePath returns void on 204', async t => {
  let seenMethod;
  const c = makeClient((_url, init) => {
    seenMethod = init.method;
    return new Response(null, {status: 204});
  });
  await c.deletePath('/vault/x.md');
  t.equal(seenMethod, 'DELETE', 'method=DELETE');
});

test('VaultClient: getText returns body as string', async t => {
  const c = makeClient(() => ok('## hello', 200, 'text/markdown'));
  const r = await c.getText('/vault/topics/alpha.md');
  t.equal(r, '## hello', 'body returned as string');
});

test('VaultClient: throws on missing apiUrl or apiToken at construction', t => {
  t.throws(() => new VaultClient({apiUrl: '', apiToken: 'tok'}), 'missing apiUrl throws');
  t.throws(() => new VaultClient({apiUrl: 'http://test', apiToken: ''}), 'missing apiToken throws');
});

test('VaultClient: trailing slash on apiUrl is normalised', async t => {
  const c = new VaultClient({
    apiUrl: 'http://test/',
    apiToken: 'tok',
    fetchImpl: fakeFetch(url => {
      t.equal(url, 'http://test/system/status', 'no double slash');
      return ok({});
    })
  });
  await c.getJson('/system/status');
});
