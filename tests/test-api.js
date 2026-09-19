import test from 'tape-six';

import {api, apiJson, getToken, setToken} from '/static/ui/api.js';

const json = (status, body) =>
  new Response(JSON.stringify(body), {status, headers: {'Content-Type': 'application/json'}});

const withNetwork = async (early, fn) => {
  const saved = {fetch: globalThis.fetch, early: globalThis.__early, token: getToken()};
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({url, method: init?.method ?? 'GET'});
    return json(200, {from: 'network'});
  };
  globalThis.__early = new Map(Object.entries(early));
  setToken('tok');
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.__early = saved.early;
    setToken(saved.token);
  }
};

test('api adopts a GET started in the head, once', async t => {
  await withNetwork({'/x': Promise.resolve(json(200, {from: 'head'}))}, async calls => {
    t.deepEqual(await apiJson('/x'), {from: 'head'}, 'the head response');
    t.equal(calls.length, 0, 'no second request');
    t.notOk(globalThis.__early.has('/x'), 'handed over once');
    t.deepEqual(await apiJson('/x'), {from: 'network'}, 'a later call requests again');
    t.equal(calls.length, 1, 'one request');
  });
});

test('api leaves the head request to a GET of the same URL', async t => {
  await withNetwork({'/x': Promise.resolve(json(200, {from: 'head'}))}, async calls => {
    await api('/x', {method: 'POST'});
    t.deepEqual(calls, [{url: '/x', method: 'POST'}], 'the POST went to the network');
    t.ok(globalThis.__early.has('/x'), 'still waiting for its GET');
    t.deepEqual(await apiJson('/x', {method: 'GET'}), {from: 'head'}, 'an explicit GET adopts it');
  });
});

test('api reports an adopted failure like its own', async t => {
  const down = Promise.reject(new TypeError('Failed to fetch'));
  down.catch(() => {});
  const early = {
    '/auth': Promise.resolve(json(401, {})),
    '/gone': Promise.resolve(json(404, {})),
    '/busy': Promise.resolve(json(409, {error: 'conflict', code: 'hash_mismatch'})),
    '/down': down
  };
  await withNetwork(early, async calls => {
    await t.rejects(api('/auth'), {message: 'unauthorized', status: 401}, '401');
    await t.rejects(api('/gone'), {message: 'not-found', status: 404}, '404');
    await t.rejects(api('/busy'), {message: 'conflict', status: 409, code: 'hash_mismatch'}, '409');
    await t.rejects(api('/down'), TypeError, 'a network failure');
    t.equal(calls.length, 0, 'nothing requested again');
  });
});

test('api checks the token before adopting', async t => {
  await withNetwork({'/x': Promise.resolve(json(200, {from: 'head'}))}, async () => {
    setToken('');
    await t.rejects(api('/x'), {message: 'no-token'}, 'no token');
    t.ok(globalThis.__early.has('/x'), 'left for a call that has one');
  });
});
