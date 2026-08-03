// Tests for the tools that closed the MCP↔REST parity gap: the lifecycle
// writes (supersede / move / propose) that let /vault ingest run MCP-native,
// the maintenance ops /vault sweep runs on, and the resume-bundle parameter
// /vault learn needs. Same stub shape as the other tool tests — invoke the
// handler, assert on what reached the VaultClient.

import test from 'tape-six';
import {VaultClient} from '../src/client.js';
import {registerTools} from '../src/tools.js';

const setup = (respond = () => new Response('{}', {status: 200})) => {
  let captured = null;
  const fetchImpl = (url, init = {}) => {
    captured = {url: typeof url === 'string' ? url : url.toString(), init};
    return Promise.resolve(respond(captured));
  };
  const tools = new Map();
  registerTools(
    {registerTool: (name, config, handler) => tools.set(name, {config, handler})},
    new VaultClient({apiUrl: 'http://test', apiToken: 'tok', fetchImpl})
  );
  return {
    call: (name, args) => tools.get(name).handler(args),
    has: name => tools.has(name),
    getCaptured: () => captured
  };
};

const bodyOf = captured => JSON.parse(captured.init.body);
const firstText = result => result.content[0].text;

test('every REST endpoint named in the parity gap now has a tool', t => {
  const {has} = setup();
  const expected = [
    'vault_supersede',
    'vault_move',
    'vault_propose',
    'vault_raw_inbox',
    'vault_cleanup_lint',
    'vault_embed_pending',
    'vault_incremental_reindex',
    'vault_run_scans',
    // Landed with the write-safety work, listed in the same gap.
    'vault_append',
    'vault_replace',
    'vault_patch_fm'
  ];
  for (const name of expected) t.ok(has(name), `${name} registered`);
});

test('vault_supersede → POST /vault/supersede, new_path omitted when absent', async t => {
  const {call, getCaptured} = setup(
    () =>
      new Response(
        JSON.stringify({
          old: {path: 'topics/archive/2026/a.md', record_id: 'r1'},
          new: {path: 'topics/a.md', record_id: 'r2', etag: 'e'}
        }),
        {status: 200, headers: {'Content-Type': 'application/json'}}
      )
  );
  const result = await call('vault_supersede', {
    old_path: 'topics/a.md',
    frontmatter: {title: 'A'},
    body: 'Successor.'
  });
  const captured = getCaptured();
  t.equal(captured.init.method, 'POST');
  t.equal(captured.url, 'http://test/vault/supersede');
  t.deepEqual(bodyOf(captured), {
    old_path: 'topics/a.md',
    frontmatter: {title: 'A'},
    body: 'Successor.'
  });
  t.equal(
    JSON.parse(firstText(result)).old.path,
    'topics/archive/2026/a.md',
    'archive location passed through'
  );

  await call('vault_supersede', {
    old_path: 'topics/a.md',
    new_path: 'topics/b.md',
    frontmatter: {},
    body: 'x'
  });
  t.equal(bodyOf(getCaptured()).new_path, 'topics/b.md', 'new_path forwarded when given');
});

test('vault_supersede surfaces an occupied archive slot as a conflict', async t => {
  const {call} = setup(
    () =>
      new Response(
        JSON.stringify({
          error: 'archive slot already occupied: topics/archive/2026/a.md',
          code: 'conflict'
        }),
        {status: 409, headers: {'Content-Type': 'application/json'}}
      )
  );
  const result = await call('vault_supersede', {
    old_path: 'topics/a.md',
    frontmatter: {},
    body: 'x'
  });
  t.ok(result.isError, 'flagged as an error result');
  t.equal(JSON.parse(firstText(result)).status, 409);
});

test('vault_move → POST /vault/move and reports the 204 as ok', async t => {
  const {call, getCaptured} = setup(() => new Response(null, {status: 204}));
  const result = await call('vault_move', {from: 'raw/a.md', to: 'raw/archive/2026-08-03-a.md'});
  const captured = getCaptured();
  t.equal(captured.url, 'http://test/vault/move');
  t.deepEqual(bodyOf(captured), {from: 'raw/a.md', to: 'raw/archive/2026-08-03-a.md'});
  t.deepEqual(JSON.parse(firstText(result)), {
    ok: true,
    from: 'raw/a.md',
    to: 'raw/archive/2026-08-03-a.md'
  });
});

test('vault_propose → POST /vault/propose, optionals omitted unless given', async t => {
  const {call, getCaptured} = setup(
    () =>
      new Response(JSON.stringify({candidates: [], proposed_chunks: 2, candidates_screened: 10}), {
        status: 200,
        headers: {'Content-Type': 'application/json'}
      })
  );
  await call('vault_propose', {body: 'draft text'});
  t.deepEqual(bodyOf(getCaptured()), {body: 'draft text'}, 'no undefined keys in the payload');

  await call('vault_propose', {body: 'draft', path: 'topics/a.md', k: 5});
  t.deepEqual(bodyOf(getCaptured()), {body: 'draft', path: 'topics/a.md', k: 5});
});

test('maintenance tools hit their endpoints with POST and no body', async t => {
  const {call, getCaptured} = setup();
  const routes = [
    ['vault_cleanup_lint', 'http://test/maintenance/cleanup-lint'],
    ['vault_embed_pending', 'http://test/maintenance/embed-pending'],
    ['vault_incremental_reindex', 'http://test/maintenance/incremental-reindex'],
    ['vault_run_scans', 'http://test/maintenance/run-all']
  ];
  for (const [name, url] of routes) {
    await call(name, {});
    const captured = getCaptured();
    t.equal(captured.init.method, 'POST', `${name} uses POST`);
    t.equal(captured.url, url, `${name} → ${url}`);
    t.equal(captured.init.body, undefined, `${name} sends no body`);
  }
});

test('vault_raw_inbox is a GET and passes the ready/drafts split through', async t => {
  const {call, getCaptured} = setup(
    () =>
      new Response(
        JSON.stringify({
          ready: [{path: 'raw/a.md', title: 'A', updated: '2026-08-01'}],
          drafts: [{path: 'raw/b.md', title: null, updated: null}]
        }),
        {status: 200, headers: {'Content-Type': 'application/json'}}
      )
  );
  const result = await call('vault_raw_inbox', {});
  t.equal(getCaptured().init.method, 'GET');
  t.equal(getCaptured().url, 'http://test/maintenance/raw-inbox');
  const payload = JSON.parse(firstText(result));
  t.equal(payload.ready.length, 1, 'ready notes surfaced');
  t.equal(payload.drafts.length, 1, 'drafts surfaced separately, not merged into ready');
});

test('vault_resume_bundle serialises project_bodies as CSV', async t => {
  const {call, getCaptured} = setup();

  await call('vault_resume_bundle', {project: 'vault-storage', logs: 3});
  t.ok(
    !getCaptured().url.includes('project_bodies'),
    'omitted entirely when not asked for, so the server keeps its feedback-only default'
  );

  await call('vault_resume_bundle', {
    project: 'vault-storage',
    project_bodies: ['learnings', 'decisions']
  });
  const url = getCaptured().url;
  t.ok(url.includes('project_bodies=learnings%2Cdecisions'), 'CSV-encoded for the REST query');
  t.ok(url.includes('project=vault-storage'), 'project still sent');
});
