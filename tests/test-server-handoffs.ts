import test from 'tape-six';
import {existsSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {HandoffsRepository} from '../src/records/handoffs.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-handoffs';
const ROLE = 'repo:github.com/uhop/deep6';

const makeEnv = (port: number, dataPath: string): ServerEnv => ({
  vaultDataPath: dataPath,
  vaultIngestPath: null,
  vaultDbPath: ':memory:',
  apiToken: TEST_TOKEN,
  host: '127.0.0.1',
  port,
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

interface ServerCtx {
  root: string;
  db: DatabaseSync;
  handle: ServerHandle;
  url: string;
}

const startCtx = async (root?: string): Promise<ServerCtx> => {
  const dir = root ?? mkdtempSync(join(tmpdir(), 'vault-storage-handoffs-test-'));
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  const handle = await startServer({
    db,
    env: makeEnv(0, dir),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {root: dir, db, handle, url: `http://127.0.0.1:${port}`};
};

const stopCtx = async (ctx: ServerCtx, keepRoot = false): Promise<void> => {
  await ctx.handle.close();
  ctx.db.close();
  if (!keepRoot) rmSync(ctx.root, {recursive: true, force: true});
};

const api = async (
  url: string,
  method: string,
  body?: unknown
): Promise<{status: number; body: any}> => {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      ...(body !== undefined ? {'Content-Type': 'application/json'} : {})
    },
    ...(body !== undefined ? {body: JSON.stringify(body)} : {})
  });
  const text = await res.text();
  return {status: res.status, body: text.length === 0 ? null : JSON.parse(text)};
};

const createPayload = (
  key: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  idempotency_key: key,
  project: 'deep6',
  to: ROLE,
  kind: 'review-branch',
  ref: {type: 'branch', value: 'topic-x'},
  from: {host: 'mba', session: 'session-b', repo: 'repo:github.com/uhop/vault-storage'},
  body: 'Please review the topic-x branch.\n\nIt fixes the flaky matcher.',
  ...overrides
});

test('handoffs: create → list → get round-trip, idempotent by key, spooled', async t => {
  const ctx = await startCtx();
  try {
    const created = await api(`${ctx.url}/handoffs`, 'POST', createPayload('k-1'));
    t.equal(created.status, 200);
    t.equal(created.body.status, 'created');
    const id = created.body.handoff.id as string;
    t.ok(id, 'id assigned');
    t.equal(created.body.handoff.status, 'open');

    const retry = await api(`${ctx.url}/handoffs`, 'POST', createPayload('k-1'));
    t.equal(retry.body.status, 'existing', 'same idempotency key returns the original');
    t.equal(retry.body.handoff.id, id, 'no second handoff filed');

    const byRole = await api(`${ctx.url}/handoffs?to=${encodeURIComponent(ROLE)}`, 'GET');
    t.equal(byRole.body.count, 1);
    const single = await api(`${ctx.url}/handoffs/${id}`, 'GET');
    t.equal(single.status, 200);
    t.equal(single.body.from.host, 'mba');
    t.equal(single.body.ref.value, 'topic-x');

    const sidecar = join(ctx.root, 'handoff', 'deep6', 'open', `${id}.md`);
    t.ok(existsSync(sidecar), 'sidecar written to handoff/<project>/open/');
    const text = readFileSync(sidecar, 'utf8');
    t.ok(text.includes('idempotency_key: k-1'), 'sidecar carries the idempotency key');
    t.ok(text.includes('Please review the topic-x branch.'), 'sidecar carries the prose body');
    t.ok(existsSync(join(ctx.root, 'handoff', '.gitignore')), 'spool is self-gitignoring');

    const events = await api(`${ctx.url}/handoffs/events?id=${id}`, 'GET');
    t.equal(events.body.items[0].event, 'created', 'creation logged');
  } finally {
    await stopCtx(ctx);
  }
});

test('handoffs: guard-first validation on create and list', async t => {
  const ctx = await startCtx();
  try {
    const noKey = await api(
      `${ctx.url}/handoffs`,
      'POST',
      createPayload('k-x', {idempotency_key: undefined})
    );
    t.equal(noKey.status, 400, 'idempotency_key is mandatory');
    const badKind = await api(
      `${ctx.url}/handoffs`,
      'POST',
      createPayload('k-x', {kind: 'do-magic'})
    );
    t.equal(badKind.status, 400, 'kind is a closed enum');
    const spoolRef = await api(
      `${ctx.url}/handoffs`,
      'POST',
      createPayload('k-x', {ref: {type: 'spool', value: 'x'}})
    );
    t.equal(spoolRef.status, 400, 'ref.type spool is reserved for the patch-transport leg');
    const badProject = await api(
      `${ctx.url}/handoffs`,
      'POST',
      createPayload('k-x', {project: 'Bad_Name'})
    );
    t.equal(badProject.status, 400, 'project must be kebab-case');
    const noFrom = await api(
      `${ctx.url}/handoffs`,
      'POST',
      createPayload('k-x', {from: {host: 'mba'}})
    );
    t.equal(noFrom.status, 400, 'from.session required');

    const badParam = await api(`${ctx.url}/handoffs?too=${encodeURIComponent(ROLE)}`, 'GET');
    t.equal(badParam.status, 400, 'typo query param named and rejected');
    const badStatus = await api(`${ctx.url}/handoffs?status=pending`, 'GET');
    t.equal(badStatus.status, 400, 'status filter is a closed enum');
    t.equal(
      (await api(`${ctx.url}/handoffs`, 'GET')).body.count,
      0,
      'rejected creates mutate nothing'
    );
  } finally {
    await stopCtx(ctx);
  }
});

test('handoffs: claim → resolve(done) archives into vault-data and clears the spool', async t => {
  const ctx = await startCtx();
  try {
    const created = await api(`${ctx.url}/handoffs`, 'POST', createPayload('k-2'));
    const id = created.body.handoff.id as string;

    const claim = await api(`${ctx.url}/handoffs/claim`, 'POST', {id, holder: 'nuke/owner'});
    t.equal(claim.body.status, 'claimed');
    t.ok(claim.body.handoff.claim_expires, 'claim carries a TTL');

    const reclaim = await api(`${ctx.url}/handoffs/claim`, 'POST', {id, holder: 'nuke/owner'});
    t.equal(reclaim.body.status, 'renewed', 're-claim by the claimant is a renew');

    const otherClaim = await api(`${ctx.url}/handoffs/claim`, 'POST', {id, holder: 'croc/other'});
    t.equal(otherClaim.status, 409);
    t.equal(otherClaim.body.code, 'claimed_by_other');

    const wrongHolder = await api(`${ctx.url}/handoffs/resolve`, 'POST', {
      id,
      holder: 'croc/other',
      resolution: 'done'
    });
    t.equal(wrongHolder.status, 409, 'only the claimant resolves');

    const done = await api(`${ctx.url}/handoffs/resolve`, 'POST', {
      id,
      holder: 'nuke/owner',
      resolution: 'done',
      result: {merged: true}
    });
    t.equal(done.body.status, 'ok');
    t.equal(done.body.handoff.status, 'done');
    t.equal(done.body.archived_to, 'projects/deep6/handoff-archive.md');

    const archive = readFileSync(join(ctx.root, 'projects', 'deep6', 'handoff-archive.md'), 'utf8');
    t.ok(archive.includes(`### ${id}`), 'archive carries the handoff section');
    t.ok(archive.includes('> Please review the topic-x branch.'), 'body archived blockquoted');
    t.ok(archive.includes('"merged":true'), 'result archived');

    for (const status of ['open', 'claimed', 'done']) {
      t.notOk(
        existsSync(join(ctx.root, 'handoff', 'deep6', status, `${id}.md`)),
        `spool entry cleared from ${status}/`
      );
    }

    const row = await api(`${ctx.url}/handoffs/${id}`, 'GET');
    t.equal(row.body.status, 'done', 'the poller still sees the resolution');
  } finally {
    await stopCtx(ctx);
  }
});

test('handoffs: the review loop — returned reopens the same record', async t => {
  const ctx = await startCtx();
  try {
    const created = await api(`${ctx.url}/handoffs`, 'POST', createPayload('k-3'));
    const id = created.body.handoff.id as string;
    await api(`${ctx.url}/handoffs/claim`, 'POST', {id, holder: 'nuke/owner'});

    const noNote = await api(`${ctx.url}/handoffs/resolve`, 'POST', {
      id,
      holder: 'nuke/owner',
      resolution: 'returned'
    });
    t.equal(noNote.status, 400, 'returned requires the critique note');

    const returned = await api(`${ctx.url}/handoffs/resolve`, 'POST', {
      id,
      holder: 'nuke/owner',
      resolution: 'returned',
      note: 'Tests are missing for the matcher edge case.'
    });
    t.equal(returned.body.handoff.status, 'returned');
    t.equal(returned.body.handoff.notes.length, 1, 'critique rides notes');
    t.equal(returned.body.handoff.notes[0].author, 'nuke/owner');
    t.ok(
      existsSync(join(ctx.root, 'handoff', 'deep6', 'returned', `${id}.md`)),
      'sidecar moved to returned/'
    );

    const claimReturned = await api(`${ctx.url}/handoffs/claim`, 'POST', {
      id,
      holder: 'nuke/owner'
    });
    t.equal(claimReturned.status, 409, "returned is the submitter's turn, not claimable");
    t.equal(claimReturned.body.code, 'not_open');

    const resubmit = await api(`${ctx.url}/handoffs/resubmit`, 'POST', {
      id,
      ref: {type: 'branch', value: 'topic-x-v2'},
      body: 'Reworked: matcher edge case now covered.'
    });
    t.equal(resubmit.body.handoff.status, 'open', 'resubmission reuses the record');
    t.equal(resubmit.body.handoff.id, id, 'same id — no new handoff');
    t.equal(resubmit.body.handoff.ref.value, 'topic-x-v2');
    t.ok(
      existsSync(join(ctx.root, 'handoff', 'deep6', 'open', `${id}.md`)),
      'sidecar back in open/'
    );

    const resubmitOpen = await api(`${ctx.url}/handoffs/resubmit`, 'POST', {id});
    t.equal(resubmitOpen.status, 409, 'only a returned handoff resubmits');

    const note = await api(`${ctx.url}/handoffs/note`, 'POST', {
      id,
      author: 'mba/session-b',
      text: 'Rebased on latest main too.'
    });
    t.equal(note.body.handoff.notes.length, 2, 'notes are append-only discussion');

    await api(`${ctx.url}/handoffs/claim`, 'POST', {id, holder: 'nuke/owner'});
    await api(`${ctx.url}/handoffs/resolve`, 'POST', {
      id,
      holder: 'nuke/owner',
      resolution: 'done'
    });
    const lateNote = await api(`${ctx.url}/handoffs/note`, 'POST', {id, author: 'x', text: 'y'});
    t.equal(lateNote.status, 409, 'no notes after resolution');
    t.equal(lateNote.body.code, 'handoff_resolved');
  } finally {
    await stopCtx(ctx);
  }
});

test('handoffs: claim expiry is lazy, logged, and reverts to open', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-handoffs-test-'));
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  try {
    // Repository-level with pinned timestamps — the HTTP layer always uses
    // wall-clock now.
    const repo = new HandoffsRepository(db, root);
    const t0 = '2026-08-10T00:00:00.000Z';
    const {handoff} = repo.create({
      idempotencyKey: 'k-exp',
      project: 'deep6',
      to: ROLE,
      kind: 'run-check',
      from: {host: 'mba', session: 's'},
      body: 'Run the browser suite.',
      now: t0
    });
    repo.claim(handoff.id, 'nuke/owner', 60, t0);
    const later = '2026-08-10T00:02:00.000Z';
    const after = repo.get(handoff.id, later);
    t.equal(after?.status, 'open', 'expired claim reverted on next touch');
    t.equal(after?.claimedBy, null, 'claim fields cleared');
    t.ok(
      existsSync(join(root, 'handoff', 'deep6', 'open', `${handoff.id}.md`)),
      'sidecar moved back to open/'
    );
    const events = repo.events(handoff.id).map(e => e.event);
    t.ok(events.includes('claim_expired'), 'expiry logged');
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('handoffs: rebuilt from the spool on server start — files are truth', async t => {
  const first = await startCtx();
  let id1 = '';
  let id2 = '';
  try {
    const a = await api(`${first.url}/handoffs`, 'POST', createPayload('k-r1'));
    id1 = a.body.handoff.id;
    await api(`${first.url}/handoffs/note`, 'POST', {
      id: id1,
      author: 'mba/s',
      text: 'context note'
    });
    const b = await api(
      `${first.url}/handoffs`,
      'POST',
      createPayload('k-r2', {kind: 'answer-question', ref: undefined})
    );
    id2 = b.body.handoff.id;
    await api(`${first.url}/handoffs/claim`, 'POST', {id: id2, holder: 'nuke/owner'});
  } finally {
    await stopCtx(first, true);
  }

  const second = await startCtx(first.root);
  try {
    const list = await api(`${second.url}/handoffs`, 'GET');
    t.equal(list.body.count, 2, 'fresh DB, both handoffs rebuilt by scan');
    const one = await api(`${second.url}/handoffs/${id1}`, 'GET');
    t.equal(one.body.status, 'open');
    t.equal(one.body.notes.length, 1, 'notes survive the restart');
    t.equal(one.body.idempotency_key, 'k-r1', 'idempotency key survives — retry still safe');
    const two = await api(`${second.url}/handoffs/${id2}`, 'GET');
    t.equal(two.body.status, 'claimed', 'live claim survives (TTL is wall-clock)');
    t.equal(two.body.claimed_by, 'nuke/owner');
  } finally {
    await stopCtx(second);
  }
});

test('handoffs: crash between resolve and archive completes on next start', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-handoffs-test-'));
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  const repo = new HandoffsRepository(db, root);
  const {handoff} = repo.create({
    idempotencyKey: 'k-crash',
    project: 'deep6',
    to: ROLE,
    kind: 'apply-patch',
    from: {host: 'mba', session: 's'},
    body: 'Apply the queued patch.'
  });
  repo.claim(handoff.id, 'nuke/owner');
  // Repository-level resolve only: the archival step (normally the handler's)
  // never runs — the crash window.
  repo.resolve(handoff.id, 'nuke/owner', 'done', {merged: true});
  db.close();

  const ctx = await startCtx(root);
  try {
    const archive = join(root, 'projects', 'deep6', 'handoff-archive.md');
    t.ok(existsSync(archive), 'server start completed the pending archival');
    t.ok(readFileSync(archive, 'utf8').includes(`### ${handoff.id}`), 'archive carries the entry');
    t.notOk(
      existsSync(join(root, 'handoff', 'deep6', 'done', `${handoff.id}.md`)),
      'spool entry cleared after archival'
    );
    const row = await api(`${ctx.url}/handoffs/${handoff.id}`, 'GET');
    t.equal(row.body.status, 'done', 'resolution preserved');
  } finally {
    await stopCtx(ctx);
  }
});

test('handoffs: resume bundle inherits the inbox; brief counts pending', async t => {
  const ctx = await startCtx();
  try {
    await api(`${ctx.url}/handoffs`, 'POST', createPayload('k-b1', {project: 'myproj'}));
    const returned = await api(
      `${ctx.url}/handoffs`,
      'POST',
      createPayload('k-b2', {project: 'myproj'})
    );
    const rid = returned.body.handoff.id;
    await api(`${ctx.url}/handoffs/claim`, 'POST', {id: rid, holder: 'nuke/owner'});
    await api(`${ctx.url}/handoffs/resolve`, 'POST', {
      id: rid,
      holder: 'nuke/owner',
      resolution: 'returned',
      note: 'needs a rebase'
    });

    const bundle = await api(`${ctx.url}/system/resume-bundle?project=myproj&logs=0`, 'POST');
    t.equal(bundle.body.project.handoffs.open.length, 1, 'open inbox surfaces in the bundle');
    t.equal(bundle.body.project.handoffs.returned.length, 1, 'returned rework surfaces too');
    t.equal(
      bundle.body.project.handoffs.open[0].body_first_line,
      'Please review the topic-x branch.',
      'inbox items carry a first-line glance, not the body'
    );

    const brief = await api(`${ctx.url}/system/resume-brief?project=myproj`, 'GET');
    t.equal(brief.body.project.handoffs_pending, 2, 'brief counts open + returned');
  } finally {
    await stopCtx(ctx);
  }
});
