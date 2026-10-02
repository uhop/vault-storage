import test from 'tape-six';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {KeyStore} from '../src/server/keys.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const LEGACY = 'test-token-keys';

const makeEnv = (dataPath: string, keysPath: string | null): ServerEnv => ({
  vaultDataPath: dataPath,
  vaultIngestPath: null,
  vaultDbPath: ':memory:',
  apiToken: LEGACY,
  keysPath,
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
});

interface Ctx {
  root: string;
  keysPath: string | null;
  db: DatabaseSync;
  handle: ServerHandle;
  url: string;
}

const startCtx = async (withFile = true): Promise<Ctx> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-keys-'));
  mkdirSync(join(root, 'topics'), {recursive: true});
  writeFileSync(join(root, 'topics/a.md'), '---\ntitle: A\ntype: permanent\n---\nBody.\n');
  const keysPath = withFile ? join(root, '.vault-storage', 'keys.json') : null;
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, root);
  const env = makeEnv(root, keysPath);
  const keys = new KeyStore({
    path: keysPath,
    legacyToken: LEGACY,
    vaultDataPath: root,
    reloadEveryMs: 0
  });
  const handle = await startServer({
    db,
    env,
    schemaVersion: migration.current,
    embedder: new FakeEmbedder(),
    keys
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {root, keysPath, db, handle, url: `http://127.0.0.1:${port}`};
};

const stopCtx = async (ctx: Ctx): Promise<void> => {
  await ctx.handle.close();
  ctx.db.close();
  rmSync(ctx.root, {recursive: true, force: true});
};

const call = async (
  url: string,
  token: string,
  init: {method?: string; body?: unknown} = {}
): Promise<{status: number; body: any}> => {
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : {'Content-Type': 'application/json'})
    },
    ...(init.body === undefined ? {} : {body: JSON.stringify(init.body)})
  });
  const text = await res.text();
  return {status: res.status, body: text ? JSON.parse(text) : null};
};

test('the API token is the implicit person key "operator"', async t => {
  const ctx = await startCtx();
  try {
    const me = await call(`${ctx.url}/keys/me`, LEGACY);
    t.equal(me.status, 200);
    t.deepEqual(me.body, {key_id: 'legacy', name: 'operator', kind: 'person', email: null});
    t.equal((await call(`${ctx.url}/keys/me`, 'wrong')).status, 401, 'a wrong token is refused');
  } finally {
    await stopCtx(ctx);
  }
});

test('POST /keys answers the secret once and the file holds only its hash', async t => {
  const ctx = await startCtx();
  try {
    const made = await call(`${ctx.url}/keys`, LEGACY, {
      method: 'POST',
      body: {name: 'uhop agents', kind: 'agent', email: 'agents@example.com'}
    });
    t.equal(made.status, 201);
    const {key, secret} = made.body;
    t.ok(/^vsk_[A-Za-z0-9_-]{43}$/.test(secret), 'a prefixed secret of 32 random bytes');
    t.match(key, {
      name: 'uhop agents',
      kind: 'agent',
      email: 'agents@example.com',
      status: 'active'
    });
    t.notOk('hash' in key, 'the answer carries no hash');

    const text = readFileSync(ctx.keysPath!, 'utf8');
    t.notOk(text.includes(secret), 'the file never holds the secret');
    t.ok(text.includes(key.id), 'it holds the key');
    t.equal(statSync(ctx.keysPath!).mode & 0o777, 0o600, 'readable by the owner only');
    t.equal(
      readFileSync(join(ctx.root, '.vault-storage', '.gitignore'), 'utf8'),
      '*\n',
      'a key file inside the vault is never committed'
    );

    const me = await call(`${ctx.url}/keys/me`, secret);
    t.deepEqual(me.body, {
      key_id: key.id,
      name: 'uhop agents',
      kind: 'agent',
      email: 'agents@example.com'
    });
    t.equal((await call(`${ctx.url}/system/status`, secret)).status, 200, 'the agent key reads');

    const list = await call(`${ctx.url}/keys`, LEGACY);
    t.equal(list.status, 200);
    t.equal(list.body.items.length, 1);
    t.notOk('hash' in list.body.items[0], 'the listing carries no hash');
  } finally {
    await stopCtx(ctx);
  }
});

test("an agent key cannot do a person's acts", async t => {
  const ctx = await startCtx();
  try {
    const {secret} = (
      await call(`${ctx.url}/keys`, LEGACY, {method: 'POST', body: {name: 'bot', kind: 'agent'}})
    ).body;
    const refused = await call(`${ctx.url}/keys`, secret, {
      method: 'POST',
      body: {name: 'escalate', kind: 'person'}
    });
    t.equal(refused.status, 403);
    t.equal(refused.body.code, 'forbidden');
    t.equal((await call(`${ctx.url}/keys`, secret)).status, 403, 'listing keys');

    const lease = {resource: 'repo:github.com/x/y', holder: 'nuke/1'};
    const claim = await call(`${ctx.url}/leases/claim`, LEGACY, {method: 'POST', body: lease});
    t.equal(claim.status, 200);
    const forced = await call(`${ctx.url}/leases/release`, secret, {
      method: 'POST',
      body: {...lease, holder: 'mba/2', force: true}
    });
    t.equal(forced.status, 403, 'a forced release');
    const byPerson = await call(`${ctx.url}/leases/release`, LEGACY, {
      method: 'POST',
      body: {...lease, holder: 'mba/2', force: true}
    });
    t.equal(byPerson.status, 200, "a person's key forces the release");
  } finally {
    await stopCtx(ctx);
  }
});

test('a recalled or expired key stops at once', async t => {
  const ctx = await startCtx();
  try {
    const {key, secret} = (
      await call(`${ctx.url}/keys`, LEGACY, {method: 'POST', body: {name: 'bot', kind: 'agent'}})
    ).body;
    t.equal((await call(`${ctx.url}/keys/me`, secret)).status, 200, 'a session exists');
    const recalled = await call(`${ctx.url}/keys/${key.id}/recall`, LEGACY, {method: 'POST'});
    t.equal(recalled.status, 200);
    t.equal(recalled.body.key.status, 'recalled');
    t.equal((await call(`${ctx.url}/keys/me`, secret)).status, 401, 'the session ended');
    t.equal(
      (await call(`${ctx.url}/keys/nope/recall`, LEGACY, {method: 'POST'})).status,
      404,
      'an unknown key'
    );

    const past = await call(`${ctx.url}/keys`, LEGACY, {
      method: 'POST',
      body: {name: 'old', kind: 'agent', expires_at: '2000-01-01'}
    });
    t.equal(past.body.key.status, 'expired');
    t.equal((await call(`${ctx.url}/keys/me`, past.body.secret)).status, 401, 'an expired key');

    const other = (
      await call(`${ctx.url}/keys`, LEGACY, {method: 'POST', body: {name: 'other', kind: 'agent'}})
    ).body;
    t.equal((await call(`${ctx.url}/keys/me`, other.secret)).status, 200);
    const file = JSON.parse(readFileSync(ctx.keysPath!, 'utf8'));
    file.keys = file.keys.filter((k: {id: string}) => k.id !== other.key.id);
    writeFileSync(ctx.keysPath!, JSON.stringify(file));
    t.equal(
      (await call(`${ctx.url}/keys/me`, other.secret)).status,
      401,
      'a key removed from the file by hand ends its session'
    );
  } finally {
    await stopCtx(ctx);
  }
});

test('key routes check their input and need a key file to change keys', async t => {
  const ctx = await startCtx();
  try {
    const kind = await call(`${ctx.url}/keys`, LEGACY, {
      method: 'POST',
      body: {name: 'x', kind: 'robot'}
    });
    t.equal(kind.status, 400);
    t.equal(kind.body.code, 'invalid_enum_value');
    const extra = await call(`${ctx.url}/keys`, LEGACY, {
      method: 'POST',
      body: {name: 'x', kind: 'agent', scope: 'read'}
    });
    t.equal(extra.status, 400, 'an unknown field is refused by name');
    const noName = await call(`${ctx.url}/keys`, LEGACY, {method: 'POST', body: {kind: 'agent'}});
    t.equal(noName.status, 400);

    mkdirSync(join(ctx.root, '.vault-storage'), {recursive: true});
    writeFileSync(ctx.keysPath!, '{not json');
    t.equal(
      (await call(`${ctx.url}/keys/me`, LEGACY)).status,
      200,
      'a corrupt file leaves the API token working'
    );
  } finally {
    await stopCtx(ctx);
  }

  const bare = await startCtx(false);
  try {
    const made = await call(`${bare.url}/keys`, LEGACY, {
      method: 'POST',
      body: {name: 'x', kind: 'agent'}
    });
    t.equal(made.status, 409);
    t.equal(made.body.code, 'no_key_file');
    t.deepEqual((await call(`${bare.url}/keys`, LEGACY)).body, {items: []});
    t.notOk(existsSync(join(bare.root, '.vault-storage', 'keys.json')), 'nothing written');
  } finally {
    await stopCtx(bare);
  }
});
