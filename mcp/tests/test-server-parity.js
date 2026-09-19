import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../../src/db/connection.ts';
import {runMigrations} from '../../src/db/migrate.ts';
import {FakeEmbedder} from '../../src/embeddings/fake.ts';
import {importVault} from '../../src/importer/import.ts';
import {startServer} from '../../src/server/server.ts';
import {VaultClient} from '../src/client.js';
import {registerTools} from '../src/tools.js';

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

test('every tool parameter reaches the server, and the server accepts it by name', async t => {
  const vault = await startVault();
  try {
    const pieces = await fetch(`${vault.url}/sections?file_prefix=topics/beta.md`, {
      headers: {Authorization: 'Bearer tok'}
    });
    real.set('path', 'topics/beta.md');
    real.set('record_id', (await pieces.json()).items[0].record_id);
    let wire = [];
    const fetchImpl = (url, init = {}) => {
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
        const {wire, error} = await call(tool, {...required, [key]: sample(key, shape[key])});
        const refused =
          error?.status === 400 && /unknown query parameter|\bwas removed\b/.test(error.error);
        t.notOk(refused, `${tool.name} ${key}: the server refuses it by name`);
        if (!(key in required) && !CLIENT_SIDE.has(`${tool.name} ${key}`)) {
          t.notEqual(wire, baseline.wire, `${tool.name} ${key}: changes the request`);
        }
      }
    }

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
