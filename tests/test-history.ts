import test from 'tape-six';
import {execSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import {parseFrontmatter} from '../src/markdown/frontmatter.ts';
import {RecordsRepository} from '../src/records/repository.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-history';

// Enough unchanged lines that git reads the move to b.md as a rename.
const STEADY = Array.from({length: 8}, (_, i) => `A line that stays, number ${i}.`).join('\n');
const V1 = `---\ntitle: A\ntype: permanent\n---\nThe first version of the note.\n${STEADY}\n`;
const V2 = `---\ntitle: A\ntype: permanent\n---\nThe second version, edited.\n${STEADY}\n`;
const V3 = `---\ntitle: A\ntype: permanent\n---\nThe second version, edited and moved.\n${STEADY}\n`;

const git = (cwd: string, args: string): string =>
  execSync(`git ${args}`, {cwd, stdio: ['ignore', 'pipe', 'ignore']})
    .toString()
    .trim();

const write = (root: string, path: string, text: string): void => {
  mkdirSync(join(root, path, '..'), {recursive: true});
  writeFileSync(join(root, path), text);
};

/** topics/a.md in two commits, then renamed to topics/b.md; topics/c.md added and deleted. */
const initRepo = (): {root: string; shas: Record<string, string>} => {
  const root = mkdtempSync(join(tmpdir(), 'vault-history-test-'));
  git(root, 'init -q -b main');
  git(root, 'config user.email tester@example.com');
  git(root, 'config user.name Tester');
  const shas: Record<string, string> = {};
  const commit = (name: string): void => {
    git(root, 'add -A');
    git(root, `commit -q -m ${name}`);
    shas[name] = git(root, 'rev-parse HEAD');
  };
  write(root, 'topics/a.md', V1);
  write(root, 'topics/c.md', '---\ntitle: C\n---\nA note deleted later.\n');
  commit('one');
  write(root, 'topics/a.md', V2);
  commit('two');
  git(root, 'mv topics/a.md topics/b.md');
  write(root, 'topics/b.md', V3);
  commit('three');
  git(root, 'rm -q topics/c.md');
  commit('four');
  return {root, shas};
};

const makeEnv = (dataPath: string): ServerEnv => ({
  vaultDataPath: dataPath,
  vaultIngestPath: null,
  vaultDbPath: ':memory:',
  apiToken: TEST_TOKEN,
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
  commitIntervalMs: 60_000,
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
  db: DatabaseSync;
  handle: ServerHandle;
  url: string;
  root: string;
}

const start = async (root: string): Promise<Ctx> => {
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, root);
  const handle = await startServer({
    db,
    env: makeEnv(root),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {db, handle, url: `http://127.0.0.1:${port}`, root};
};

const stop = async ({db, handle, root}: Ctx): Promise<void> => {
  await handle.close();
  db.close();
  rmSync(root, {recursive: true, force: true});
};

const call = async (
  url: string,
  init: RequestInit = {}
): Promise<{status: number; text: string; headers: Headers}> => {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${TEST_TOKEN}`);
  const res = await fetch(url, {...init, headers});
  return {status: res.status, text: await res.text(), headers: res.headers};
};

const json = async (url: string, init: RequestInit = {}) => {
  const r = await call(url, init);
  return {status: r.status, body: r.text.length ? JSON.parse(r.text) : null};
};

const restore = (ctx: Ctx, body: Record<string, unknown>) =>
  json(`${ctx.url}/vault/restore`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });

interface Item {
  sha: string;
  subject: string;
  path: string;
  change: string;
}

test('GET /history lists a note across its rename, a page at a time', async t => {
  const {root, shas} = initRepo();
  const ctx = await start(root);
  try {
    const all = await json(`${ctx.url}/history?path=topics/b.md`);
    t.equal(all.status, 200);
    t.equal(all.body.uncommitted, false);
    t.equal(all.body.last, true);
    t.deepEqual(
      all.body.items.map((i: Item) => [i.sha, i.subject, i.path, i.change]),
      [
        [shas['three'], 'three', 'topics/b.md', 'renamed'],
        [shas['two'], 'two', 'topics/a.md', 'modified'],
        [shas['one'], 'one', 'topics/a.md', 'added']
      ]
    );

    const first = await json(`${ctx.url}/history?path=topics/b.md&limit=2`);
    t.deepEqual(
      [first.body.items.length, first.body.last, first.body.offset, first.body.limit],
      [2, false, 0, 2]
    );
    const second = await json(`${ctx.url}/history?path=topics/b.md&offset=2&limit=2`);
    t.deepEqual(
      second.body.items.map((i: Item) => i.subject),
      ['one']
    );
    t.equal(second.body.last, true);

    const deleted = await json(`${ctx.url}/history?path=topics/c.md`);
    t.deepEqual(
      deleted.body.items.map((i: Item) => i.change),
      ['deleted', 'added'],
      'a deleted note keeps its history'
    );

    write(root, 'topics/new.md', '---\ntitle: New\n---\nNever committed.\n');
    const fresh = await json(`${ctx.url}/history?path=topics/new.md`);
    t.deepEqual([fresh.body.items, fresh.body.uncommitted], [[], true]);

    t.equal((await json(`${ctx.url}/history`)).status, 400, 'path is required');
    t.equal((await json(`${ctx.url}/history?path=../x.md`)).status, 400, 'inside the vault');
  } finally {
    await stop(ctx);
  }
});

test('GET /vault/{path}?at= reads a version by its own path', async t => {
  const {root, shas} = initRepo();
  const ctx = await start(root);
  try {
    const old = await call(`${ctx.url}/vault/topics/a.md?at=${shas['one']}`);
    t.equal(old.status, 200);
    t.equal(old.text, V1);
    t.equal(old.headers.get('x-vault-version'), shas['one']);
    t.equal(old.headers.get('etag'), null, 'a version is no precondition');

    const short = await call(`${ctx.url}/vault/topics/a.md?at=${shas['two']!.slice(0, 7)}`);
    t.equal(short.text, V2, 'an abbreviated sha works');

    t.equal((await call(`${ctx.url}/vault/topics/b.md?at=${shas['one']}`)).status, 404);
    t.equal((await call(`${ctx.url}/vault/topics/b.md?at=deadbee`)).status, 404);
    t.equal((await call(`${ctx.url}/vault/topics/b.md?at=HEAD`)).status, 400, 'a sha only');
    t.equal((await call(`${ctx.url}/vault/topics/b.md?at=-p`)).status, 400, 'no option');
    const rendered = await json(`${ctx.url}/vault/topics/a.md?at=${shas['one']}&render=html`);
    t.equal(rendered.status, 200, 'a version renders');
    t.matchString(rendered.body.html, /The first version of the note/);
    t.equal(rendered.body.version, shas['one']);
    t.equal(rendered.body.etag, undefined, 'and carries no etag');
    t.equal(
      (await call(`${ctx.url}/vault/topics/a.md?at=${shas['one']}&section=x`)).status,
      400,
      'at combines with render only'
    );
  } finally {
    await stop(ctx);
  }
});

test('POST /vault/restore writes a version back and keeps what it replaced', async t => {
  const {root, shas} = initRepo();
  const ctx = await start(root);
  const records = new RecordsRepository(ctx.db);
  try {
    const id = records.getByPath('topics/b.md')?.recordId;
    t.ok(id);

    const stale = await restore(ctx, {
      path: 'topics/b.md',
      sha: shas['one'],
      from_path: 'topics/a.md',
      expected_etag: 'not-the-etag'
    });
    t.equal(stale.status, 412, 'a stale etag writes nothing');
    t.equal(readFileSync(join(root, 'topics/b.md'), 'utf8'), V3);

    const edited = '---\ntitle: B\ntype: permanent\n---\nAn edit nobody committed.\n';
    write(root, 'topics/b.md', edited);
    const head = await call(`${ctx.url}/vault/topics/b.md`);
    const etag = head.headers.get('etag')!.replaceAll('"', '');

    const done = await restore(ctx, {
      path: 'topics/b.md',
      sha: shas['one'],
      from_path: 'topics/a.md',
      expected_etag: etag
    });
    t.equal(done.status, 200);
    t.deepEqual(done.body.restored_from, {sha: shas['one'], path: 'topics/a.md'});
    t.ok(done.body.committed_before, 'the uncommitted edit was committed first');
    t.equal(
      parseFrontmatter(readFileSync(join(root, 'topics/b.md'), 'utf8')).body,
      parseFrontmatter(V1).body,
      'the body is the version'
    );
    t.equal(records.getByPath('topics/b.md')?.recordId, id, 'the record keeps its id');

    const history = await json(`${ctx.url}/history?path=topics/b.md&limit=1`);
    const [kept] = history.body.items as Item[];
    t.equal(kept?.sha, done.body.committed_before);
    t.matchString(kept!.subject, /before restoring/);
    const keptText = await call(`${ctx.url}/vault/topics/b.md?at=${kept!.sha}`);
    t.equal(keptText.text, edited, 'the replaced content is a version');
    t.equal(history.body.uncommitted, true, 'the restore itself waits for the next commit');
  } finally {
    await stop(ctx);
  }
});

test('POST /vault/restore brings back a deleted note and refuses what it cannot find', async t => {
  const {root, shas} = initRepo();
  const ctx = await start(root);
  try {
    t.notOk(existsSync(join(root, 'topics/c.md')));
    const back = await restore(ctx, {path: 'topics/c.md', sha: shas['three']});
    t.equal(back.status, 200);
    t.equal(back.body.committed_before, null, 'nothing uncommitted to keep');
    t.ok(new RecordsRepository(ctx.db).getByPath('topics/c.md'), 'indexed again');

    t.equal((await restore(ctx, {path: 'topics/c.md', sha: 'deadbee'})).status, 404);
    t.equal((await restore(ctx, {path: 'topics/c.md', sha: 'HEAD'})).status, 400);
    t.equal((await restore(ctx, {path: 'topics/c.txt', sha: shas['one']})).status, 400);
    t.equal((await restore(ctx, {path: '../c.md', sha: shas['one']})).status, 400);
  } finally {
    await stop(ctx);
  }
});

test('history and restore answer 503 when the vault is not a git repository', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vault-history-plain-'));
  write(root, 'topics/a.md', V1);
  const ctx = await start(root);
  try {
    t.equal((await json(`${ctx.url}/history?path=topics/a.md`)).status, 503);
    t.equal((await call(`${ctx.url}/vault/topics/a.md?at=deadbee`)).status, 503);
    t.equal((await restore(ctx, {path: 'topics/a.md', sha: 'deadbee'})).status, 503);
  } finally {
    await stop(ctx);
  }
});
