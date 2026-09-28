import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../src/db/connection.ts';
import {runMigrations} from '../../src/db/migrate.ts';
import {FakeEmbedder} from '../../src/embeddings/fake.ts';
import {importVault} from '../../src/importer/import.ts';
import {buildRouter, startServer} from '../../src/server/server.ts';
import {VaultClient} from '../src/client.js';
import {registerTools} from '../src/tools.js';

// Server routes no tool reaches, each with the reason (checked against the router below).
const UNEXPOSED = new Map([
  ['GET /drafts', 'UI-only: the editor drafts'],
  ['PUT /drafts', 'UI-only: the editor drafts'],
  ['DELETE /drafts/{id}', 'UI-only: the editor drafts'],
  ['POST /vault/render', 'UI-only: server-side markdown render'],
  ['GET /resolve', 'UI-only: wikilink resolution for the note page'],
  ['POST /resolve', 'UI-only: wikilink resolution for the note page'],
  ['GET /system/resume-brief', 'the SessionStart hook'],
  ['GET /system/body-fields', 'diagnostic, read by this test'],
  ['GET /queue/lint', 'the vault-lint script'],
  ['POST /commit', 'deliberately not on MCP: a git commit of vault-data'],
  ['POST /maintenance/snapshot', 'deliberately not on MCP: database snapshots'],
  ['GET /maintenance/snapshot-list', 'deliberately not on MCP: database snapshots'],
  ['GET /maintenance/snapshot-download', 'deliberately not on MCP: database snapshots'],
  ['DELETE /maintenance/snapshot', 'deliberately not on MCP: database snapshots'],
  ['POST /maintenance/cleanup-tag-aliases', 'deliberately not on MCP'],
  ['POST /maintenance/release-embedder', 'deliberately not on MCP'],
  ['POST /maintenance/warm-embedder', 'called by the adapter at startup, not by a tool'],
  ['GET /maintenance/folder-listing', 'deliberately not on MCP: the UI folder browser'],
  ['POST /maintenance/find-duplicates', 'deliberately not on MCP: vault_run_scans runs all four'],
  ['POST /maintenance/find-compaction-candidates', 'deliberately not on MCP: vault_run_scans'],
  ['POST /maintenance/find-retention-candidates', 'deliberately not on MCP: vault_run_scans'],
  ['POST /maintenance/find-upgrade-signals', 'deliberately not on MCP: vault_run_scans'],
  ['POST /maintenance/expire-logs', 'a /vault sweep one-shot through vault-curl'],
  ['POST /search/simple', 'vault_search uses the GET form'],
  ['GET /sections/{id}/fm', 'vault_read_file and vault_read_meta cover it'],
  ['GET /sections/{id}/tags', 'vault_read_file covers it'],
  ['GET /handoffs/{id}/artifact', 'vault_handoff_get_artifact reaches it only for a real handoff']
]);

// Parameters that shape the tool's answer, or a follow-up request, rather than the first request.
const CLIENT_SIDE = new Set([
  'vault_read_file include_etag',
  'vault_handoff_get_artifact include_content'
]);

const unwrap = schema => {
  let optional = false;
  for (let s = schema; ; s = s._zod.def.innerType) {
    const type = s._zod.def.type;
    if (type === 'optional' || type === 'default' || type === 'prefault') optional = true;
    else if (type !== 'nullable') return {inner: s, optional};
  }
};

const defaultOf = schema => {
  for (let s = schema; s?._zod; s = s._zod.def.innerType)
    if (s._zod.def.type === 'default') return s._zod.def.defaultValue;
  return undefined;
};

// A boolean whose sample equals its default would send the baseline's request.
const probe = (key, schema) => {
  const value = sample(key, schema);
  return typeof value === 'boolean' && defaultOf(schema) === value ? !value : value;
};

// Real values for the identifiers a handler checks before it reads the body.
const real = new Map();

const sample = (key, schema) => {
  const def = unwrap(schema).inner._zod.def;
  switch (def.type) {
    case 'number':
      return 7;
    case 'boolean':
      return true;
    case 'enum':
      return Object.values(def.entries).at(-1);
    case 'literal':
      return def.values[0];
    case 'array':
      return [sample(key, def.element)];
    case 'object':
      return Object.fromEntries(Object.entries(def.shape).map(([k, v]) => [k, sample(k, v)]));
    case 'record':
      return {};
    case 'union':
      return sample(key, def.options[0]);
    default:
      return real.get(key) ?? `S${key}`;
  }
};

const startVault = async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-parity-'));
  const write = (path, text) => {
    mkdirSync(join(root, path, '..'), {recursive: true});
    writeFileSync(join(root, path), text);
  };
  write(
    'topics/alpha.md',
    '---\ntitle: Alpha\ntype: permanent\n---\n## A\n\nSee [[topics/beta]].\n'
  );
  write('topics/beta.md', '---\ntitle: Beta\ntype: permanent\n---\n## B\n\nBody.\n');
  write(
    'projects/alpha/queue.md',
    '---\ntitle: Q\ntype: project\n---\n## Backlog\n\n- **One.** x\n'
  );
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, root);
  const handle = await startServer({
    db,
    env: {
      vaultDataPath: root,
      vaultIngestPath: null,
      vaultDbPath: ':memory:',
      apiToken: 'tok',
      host: '127.0.0.1',
      port: 0,
      autoReindex: false,
      autoWatch: false,
      watchDebounceMs: 1500,
      embedder: 'fake',
      embedderRetentionMs: 1_800_000,
      embedderMaxBatch: 8,
      autoCommit: false,
      autoPush: false,
      commitIntervalMs: 60000,
      commitIntervalMaxMs: 0,
      workHoursStart: null,
      workHoursEnd: null,
      gitAuthorName: 'vault-storage',
      gitAuthorEmail: 'vault-storage@localhost',
      uiStaticPath: '',
      embedAnomalyLogPath: '',
      memoryReportIntervalMs: 0
    },
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  return {
    url: `http://127.0.0.1:${handle.server.address().port}`,
    close: async () => {
      await handle.close();
      db.close();
      rmSync(root, {recursive: true, force: true});
    }
  };
};

test('every tool parameter reaches the server, the server accepts it by name, and every route has a tool', async t => {
  const vault = await startVault();
  try {
    const pieces = await fetch(`${vault.url}/sections?file_prefix=topics/beta.md`, {
      headers: {Authorization: 'Bearer tok'}
    });
    real.set('path', 'topics/beta.md');
    real.set('record_id', (await pieces.json()).items[0].record_id);
    let wire = [];
    const reached = [];
    const fetchImpl = (url, init = {}) => {
      reached.push([init.method ?? 'GET', new URL(url).pathname]);
      wire.push(
        [
          init.method ?? 'GET',
          url,
          JSON.stringify(init.headers ?? {}),
          String(init.body ?? '')
        ].join('\t')
      );
      return fetch(url, init);
    };
    const client = new VaultClient({apiUrl: vault.url, apiToken: 'tok', fetchImpl});
    const tools = [];
    registerTools(
      {registerTool: (name, config, handler) => tools.push({name, config, handler})},
      client
    );

    const call = async (tool, args) => {
      wire = [];
      const result = await tool.handler(args);
      const error = result?.isError ? JSON.parse(result.content[0].text) : null;
      return {wire: wire.join('\n'), error};
    };

    for (const tool of tools) {
      const shape = tool.config.inputSchema ?? {};
      const keys = Object.keys(shape);
      const required = Object.fromEntries(
        keys.filter(k => !unwrap(shape[k]).optional).map(k => [k, sample(k, shape[k])])
      );
      const baseline = await call(tool, required);
      for (const key of keys) {
        const {wire, error} = await call(tool, {...required, [key]: probe(key, shape[key])});
        const refused =
          error?.status === 400 && /unknown query parameter|\bwas removed\b/.test(error.error);
        t.notOk(refused, `${tool.name} ${key}: the server refuses it by name`);
        if (!(key in required) && !CLIENT_SIDE.has(`${tool.name} ${key}`)) {
          t.notEqual(wire, baseline.wire, `${tool.name} ${key}: changes the request`);
        }
      }
    }

    const routerDb = openDatabase({path: ':memory:'});
    runMigrations(routerDb);
    const routes = buildRouter({
      db: routerDb,
      env: {vaultDataPath: tmpdir(), uiStaticPath: '', embedder: 'fake'},
      schemaVersion: 0,
      embedder: new FakeEmbedder()
    }).routes();
    const compiled = routes.map(route => {
      const [method, pattern] = route.split(' ');
      const source = pattern.replace(/\{([^/{}]+)\}/g, (_, name) =>
        name === 'path' ? '(.+)' : '([^/]+)'
      );
      return {route, method, regex: new RegExp(`^${source}$`)};
    });
    const hit = new Set();
    for (const [method, pathname] of reached) {
      const match = compiled.find(c => c.method === method && c.regex.test(pathname));
      if (match) hit.add(match.route);
    }
    routerDb.close();
    t.deepEqual(
      routes.filter(route => !hit.has(route) && !UNEXPOSED.has(route)),
      [],
      'every server route is reached by a tool or named in UNEXPOSED'
    );
    for (const route of UNEXPOSED.keys())
      t.ok(
        routes.includes(route) && !hit.has(route),
        `UNEXPOSED ${route} is a route no tool reaches`
      );

    const res = await fetch(`${vault.url}/system/body-fields`, {
      headers: {Authorization: 'Bearer tok'}
    });
    for (const {route, unknown} of (await res.json()).routes) {
      t.deepEqual(
        unknown.map(u => u.field),
        [],
        `${route}: the server reads every body field the tools send`
      );
    }
  } finally {
    await vault.close();
  }
});
