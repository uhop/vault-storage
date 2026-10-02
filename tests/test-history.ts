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

const makeEnv = (dataPath: string, keysPath: string | null = null): ServerEnv => ({
  vaultDataPath: dataPath,
  vaultIngestPath: null,
  vaultDbPath: ':memory:',
  apiToken: TEST_TOKEN,
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

const start = async (root: string, keysPath: string | null = null): Promise<Ctx> => {
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, root);
  const handle = await startServer({
    db,
    env: makeEnv(root, keysPath),
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

test('GET /history/diff compares versions across a rename, and a version with the disk', async t => {
  const {root, shas} = initRepo();
  const ctx = await start(root);
  const short = (name: string) => shas[name]!.slice(0, 8);
  try {
    const same = await json(`${ctx.url}/history/diff?path=topics/b.md`);
    t.equal(same.status, 200);
    t.deepEqual(same.body.from, {sha: shas['three'], path: 'topics/b.md'});
    t.deepEqual(same.body.to, {sha: null, path: 'topics/b.md'}, 'to defaults to the disk');
    t.equal(same.body.diff, '', 'nothing uncommitted');

    const moved = await json(
      `${ctx.url}/history/diff?path=topics/b.md&to=${shas['three']}&to_path=topics/b.md`
    );
    t.deepEqual(moved.body.from, {sha: shas['two'], path: 'topics/a.md'}, 'the version before');
    t.equal(moved.body.format, 'unified');
    t.matchString(moved.body.diff, new RegExp(`^--- ${short('two')}:topics/a.md\n`));
    t.matchString(moved.body.diff, new RegExp(`\n\\+\\+\\+ ${short('three')}:topics/b.md\n@@ `));
    t.matchString(
      moved.body.diff,
      /\n-The second version, edited\.\n\+The second version, edited and moved\.\n/
    );

    const first = await json(
      `${ctx.url}/history/diff?path=topics/b.md&to=${shas['one']}&to_path=topics/a.md`
    );
    t.equal(first.body.from, null, 'no version before the first');
    t.matchString(first.body.diff, /^--- \/dev\/null\n.*\n@@ -0,0 \+1,\d+ @@/);

    const words = await json(
      `${ctx.url}/history/diff?path=topics/b.md&from=${shas['two']}&from_path=topics/a.md&format=words`
    );
    t.equal(words.body.format, 'words');
    t.matchString(
      words.body.diff,
      /\n The second version, \n-edited\.\n\+edited and moved\.\n/,
      'words, not the line'
    );
    t.matchString(words.body.diff, /\n~\n/, 'line ends marked');

    write(root, 'topics/b.md', V3.replace('moved', 'moved again'));
    const edit = await json(`${ctx.url}/history/diff?path=topics/b.md`);
    t.deepEqual(edit.body.from, {sha: shas['three'], path: 'topics/b.md'});
    t.matchString(edit.body.diff, /\+The second version, edited and moved again\.\n/, 'the edit');

    const back = await json(
      `${ctx.url}/history/diff?path=topics/b.md&from=current&to=${shas['one']}&to_path=topics/a.md`
    );
    t.deepEqual(back.body.from, {sha: null, path: 'topics/b.md'}, 'what a restore applies');
    t.matchString(
      back.body.diff,
      new RegExp(`^--- topics/b.md\n\\+\\+\\+ ${short('one')}:topics/a.md\n`)
    );
    t.matchString(back.body.diff, /\n\+The first version of the note\.\n/);
  } finally {
    await stop(ctx);
  }
});

test('GET /history/diff reads a missing side as empty and refuses what it cannot find', async t => {
  const {root, shas} = initRepo();
  const ctx = await start(root);
  try {
    const gone = await json(`${ctx.url}/history/diff?path=topics/c.md&from=${shas['one']}`);
    t.equal(gone.status, 200);
    t.equal(gone.body.to, null, 'no note on disk');
    t.matchString(gone.body.diff, /\n\+\+\+ \/dev\/null\n@@ -1,\d+ \+0,0 @@\n-/);
    const latest = await json(`${ctx.url}/history/diff?path=topics/c.md`);
    t.deepEqual(
      [latest.body.from, latest.body.to, latest.body.diff],
      [null, null, ''],
      'a deletion'
    );

    const url = `${ctx.url}/history/diff?path=topics/b.md`;
    t.equal((await json(`${url}&to=${shas['four']}&to_path=topics/c.md`)).status, 404);
    t.equal((await json(`${url}&from=deadbee`)).status, 404);
    t.equal((await json(`${url}&from=HEAD`)).status, 400, 'a sha only');
    t.equal((await json(`${url}&to=-p`)).status, 400, 'no option');
    t.equal((await json(`${url}&from_path=topics/a.md`)).status, 400, 'from_path needs from');
    t.equal((await json(`${url}&to=current&to_path=topics/a.md`)).status, 400, 'to_path needs to');
    t.equal((await json(`${url}&format=html`)).status, 400);
    t.equal((await json(`${url}&context=9`)).status, 400, 'unknown parameters refused');
    t.equal((await json(`${ctx.url}/history/diff`)).status, 400, 'path is required');
    t.equal((await json(`${ctx.url}/history/diff?path=../x.md`)).status, 400, 'inside the vault');
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
    t.equal((await json(`${ctx.url}/history/diff?path=topics/a.md`)).status, 503);
    t.equal((await call(`${ctx.url}/vault/topics/a.md?at=deadbee`)).status, 503);
    t.equal((await restore(ctx, {path: 'topics/a.md', sha: 'deadbee'})).status, 503);
    t.equal((await json(`${ctx.url}/projects/p/changes?since=deadbee`)).status, 503);
  } finally {
    await stop(ctx);
  }
});

test('GET /projects/{name}/changes reads a sha as its commit time', async t => {
  const {root, shas} = initRepo();
  const ctx = await start(root);
  try {
    const r = await json(`${ctx.url}/projects/p/changes?since=${shas['two']}`);
    t.equal(r.status, 200);
    t.equal(r.body.since.sha, shas['two']);
    t.ok(Number.isFinite(Date.parse(r.body.since.date)), 'with its commit time');
    t.deepEqual([r.body.notes, r.body.more], [[], 0]);
    t.equal((await json(`${ctx.url}/projects/p/changes?since=deadbee`)).status, 404);
  } finally {
    await stop(ctx);
  }
});

test('a write by a named key is credited to its writer in the restore commit and the history', async t => {
  const {root, shas} = initRepo();
  const keysDir = mkdtempSync(join(tmpdir(), 'vault-history-keys-'));
  const ctx = await start(root, join(keysDir, 'keys.json'));
  const as = (token: string, url: string, init: RequestInit = {}) =>
    fetch(url, {
      ...init,
      headers: {...(init.headers as Record<string, string>), Authorization: `Bearer ${token}`}
    });
  try {
    const made = (await (
      await as(TEST_TOKEN, `${ctx.url}/keys`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: 'uhop agents', kind: 'agent', email: 'agents@example.com'})
      })
    ).json()) as {secret: string; key: {id: string}};
    const put = await as(made.secret, `${ctx.url}/vault/topics/b.md`, {
      method: 'PUT',
      headers: {'Content-Type': 'text/markdown'},
      body: V3.replace('moved.', 'moved, then edited by an agent.')
    });
    t.equal(put.status, 204, 'the agent writes');
    const row = ctx.db
      .prepare('SELECT name, kind FROM pending_writers WHERE path = ?')
      .get('topics/b.md');
    t.deepEqual(
      {...(row as object)},
      {name: 'uhop agents', kind: 'agent'},
      'the write is recorded'
    );

    const restored = await restore(ctx, {
      path: 'topics/b.md',
      sha: shas.two,
      from_path: 'topics/a.md'
    });
    t.equal(restored.status, 200);
    t.equal(
      git(root, 'log -1 --format=%an%x1f%ae%x1f%cn'),
      'uhop agents\x1fagents@example.com\x1fvault-storage',
      "the content the restore replaced is committed as its writer's"
    );
    t.equal(
      git(root, "log -1 '--format=%(trailers:key=Key,valueonly)'"),
      `uhop agents (agent, ${made.key.id})`,
      'with the key in a trailer'
    );
    const history = await json(`${ctx.url}/history?path=topics/b.md&limit=2`);
    t.equal(history.body.items[0].author, 'uhop agents', 'the history names the writer');
    t.equal(history.body.items[1].author, 'Tester', 'and the earlier author');
    t.equal(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM pending_writers').get() as {n: number}).n,
      0,
      "the API token's restore leaves no writer recorded"
    );
  } finally {
    await stop(ctx);
    rmSync(keysDir, {recursive: true, force: true});
  }
});
