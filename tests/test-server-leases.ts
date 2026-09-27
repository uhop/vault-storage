import test from 'tape-six';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {LeasesRepository} from '../src/records/leases.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-leases';
const REPO = 'repo:github.com/uhop/deep6';

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

const startCtx = async (): Promise<ServerCtx> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-leases-test-'));
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  const handle = await startServer({
    db,
    env: makeEnv(0, root),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {root, db, handle, url: `http://127.0.0.1:${port}`};
};

const stopCtx = async (ctx: ServerCtx): Promise<void> => {
  await ctx.handle.close();
  ctx.db.close();
  rmSync(ctx.root, {recursive: true, force: true});
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

test('leases: claim → list → renew → release round-trip', async t => {
  const ctx = await startCtx();
  try {
    const claim = await api(`${ctx.url}/leases/claim`, 'POST', {
      resource: REPO,
      holder: 'nuke/session-a',
      priority: 'cwd'
    });
    t.equal(claim.status, 200);
    t.equal(claim.body.status, 'claimed');
    t.equal(claim.body.lease.holder_kind, 'agent', 'kind defaults to agent');
    t.ok(claim.body.lease.expires_at, 'agent lease expires');
    const token = claim.body.claim_token as string;
    t.ok(typeof token === 'string' && token.length > 0, 'an agent claim returns a token');
    t.equal(claim.body.lease.claim_token, undefined, 'the lease object carries no token');

    const list = await api(`${ctx.url}/leases`, 'GET');
    t.equal(list.body.count, 1);
    t.equal(list.body.items[0].resource, REPO);
    t.equal(list.body.items[0].claim_token, undefined, 'a listing never shows the token');

    const single = await api(`${ctx.url}/leases?resource=${encodeURIComponent(REPO)}`, 'GET');
    t.equal(single.body.count, 1, 'single-resource filter, same shape');

    const nameOnly = await api(`${ctx.url}/leases/claim`, 'POST', {
      resource: REPO,
      holder: 'nuke/session-a',
      priority: 'cwd'
    });
    t.equal(nameOnly.status, 409, 're-claim by name alone is refused');
    t.equal(nameOnly.body.code, 'claim_token_mismatch');

    const reclaim = await api(`${ctx.url}/leases/claim`, 'POST', {
      resource: REPO,
      holder: 'nuke/session-a',
      priority: 'cwd',
      claim_token: token
    });
    t.equal(reclaim.body.status, 'renewed', 're-claim with the token is a renew');
    t.equal(reclaim.body.claim_token, token, 'a renew keeps the token');

    for (const op of ['renew', 'release']) {
      const bare = await api(`${ctx.url}/leases/${op}`, 'POST', {
        resource: REPO,
        holder: 'nuke/session-a'
      });
      t.equal(bare.status, 409, `${op} without the token is refused`);
      t.equal(bare.body.code, 'claim_token_mismatch');
      const wrong = await api(`${ctx.url}/leases/${op}`, 'POST', {
        resource: REPO,
        holder: 'nuke/session-a',
        claim_token: 'not-the-token'
      });
      t.equal(wrong.status, 409, `${op} with another token is refused`);
    }

    const renew = await api(`${ctx.url}/leases/renew`, 'POST', {
      resource: REPO,
      holder: 'nuke/session-a',
      claim_token: token,
      ttl_seconds: 7200
    });
    t.equal(renew.body.status, 'ok');

    const release = await api(`${ctx.url}/leases/release`, 'POST', {
      resource: REPO,
      holder: 'nuke/session-a',
      claim_token: token
    });
    t.equal(release.body.status, 'released');
    const after = await api(`${ctx.url}/leases`, 'GET');
    t.equal(after.body.count, 0, 'released lease is gone');
  } finally {
    await stopCtx(ctx);
  }
});

test('leases: conflict and the preemption lattice', async t => {
  const ctx = await startCtx();
  try {
    const side = await api(`${ctx.url}/leases/claim`, 'POST', {
      resource: REPO,
      holder: 'mba/session-b',
      priority: 'side',
      attestation: 'clean at abc1234'
    });
    t.equal(side.body.status, 'claimed');
    t.equal(side.body.lease.attestation, 'clean at abc1234', 'side claim records attestation');

    const otherSide = await api(`${ctx.url}/leases/claim`, 'POST', {
      resource: REPO,
      holder: 'croc/session-c',
      priority: 'side'
    });
    t.equal(otherSide.status, 409, 'side does not preempt side');
    t.equal(otherSide.body.code, 'claimed_by_other');
    t.equal(
      otherSide.body.details.current.holder,
      'mba/session-b',
      '409 carries the current lease'
    );

    const cwd = await api(`${ctx.url}/leases/claim`, 'POST', {
      resource: REPO,
      holder: 'nuke/session-d',
      priority: 'cwd'
    });
    t.equal(cwd.body.status, 'preempted', 'cwd preempts an agent-held side lease');
    t.equal(cwd.body.prior.holder, 'mba/session-b', 'the answer names the lease it replaced');

    const sideVsCwd = await api(`${ctx.url}/leases/claim`, 'POST', {
      resource: REPO,
      holder: 'croc/session-c',
      priority: 'side'
    });
    t.equal(sideVsCwd.status, 409, 'side does not preempt cwd');

    const human = await api(`${ctx.url}/leases/claim`, 'POST', {
      resource: REPO,
      holder: 'eugene',
      kind: 'human'
    });
    t.equal(human.body.status, 'preempted', 'the operator preempts any agent');
    t.equal(human.body.lease.expires_at, null, 'human lease never expires');
    t.equal(human.body.lease.priority, null, 'human lease has no priority');

    const cwdVsHuman = await api(`${ctx.url}/leases/claim`, 'POST', {
      resource: REPO,
      holder: 'nuke/session-d',
      priority: 'cwd'
    });
    t.equal(cwdVsHuman.status, 409, 'nothing preempts a human holder');
  } finally {
    await stopCtx(ctx);
  }
});

test('leases: human claims take no priority or ttl', async t => {
  const ctx = await startCtx();
  try {
    const bad = await api(`${ctx.url}/leases/claim`, 'POST', {
      resource: REPO,
      holder: 'eugene',
      kind: 'human',
      ttl_seconds: 3600
    });
    t.equal(bad.status, 400);
    const bad2 = await api(`${ctx.url}/leases/claim`, 'POST', {
      resource: REPO,
      holder: 'eugene',
      kind: 'human',
      priority: 'cwd'
    });
    t.equal(bad2.status, 400);
    t.equal(
      (await api(`${ctx.url}/leases`, 'GET')).body.count,
      0,
      'rejected claims mutate nothing'
    );
  } finally {
    await stopCtx(ctx);
  }
});

test('leases: expiry is lazy and logged; expired lease is re-claimable', async t => {
  const ctx = await startCtx();
  try {
    // Drive the repository directly with pinned timestamps — the HTTP layer
    // always uses wall-clock now.
    const repo = new LeasesRepository(ctx.db);
    const t0 = '2026-08-10T00:00:00.000Z';
    repo.claim({
      resource: REPO,
      holder: 'mba/session-b',
      holderKind: 'agent',
      priority: 'side',
      ttlSeconds: 60,
      now: t0
    });
    const later = '2026-08-10T00:02:00.000Z';
    t.equal(repo.get(REPO, later), null, 'expired lease is gone on next touch');
    const claim2 = repo.claim({
      resource: REPO,
      holder: 'croc/session-c',
      holderKind: 'agent',
      priority: 'side',
      now: later
    });
    t.equal(claim2.status, 'claimed', 'fair re-claim after expiry, no grace window');
    const events = repo.events(REPO).map(e => e.event);
    t.ok(events.includes('expired'), 'expiry logged');
  } finally {
    await stopCtx(ctx);
  }
});

test('leases: a reused holder name does not inherit the lapsed claim', async t => {
  const ctx = await startCtx();
  try {
    const repo = new LeasesRepository(ctx.db);
    const t0 = '2026-09-27T00:00:00.000Z';
    const first = repo.claim({
      resource: REPO,
      holder: 'nuke/reused',
      holderKind: 'agent',
      priority: 'side',
      ttlSeconds: 60,
      now: t0
    });
    const firstToken = first.status === 'claimed' ? first.lease.claimToken : null;
    const later = '2026-09-27T00:02:00.000Z';
    const second = repo.claim({
      resource: REPO,
      holder: 'nuke/reused',
      holderKind: 'agent',
      priority: 'side',
      now: later
    });
    t.equal(second.status, 'claimed', 'the lapsed claim is gone, so this is a new one');
    const secondToken = second.status === 'claimed' ? second.lease.claimToken : null;
    t.notEqual(secondToken, firstToken, 'with a new token');
    t.equal(
      repo.release(REPO, 'nuke/reused', firstToken, false, later).status,
      'token_mismatch',
      "the first claim's release leaves the second in place"
    );
    t.equal(repo.get(REPO, later)?.claimToken, secondToken);
  } finally {
    await stopCtx(ctx);
  }
});

test('leases: a cwd lease unrenewed past the grace window yields to another cwd claim', async t => {
  const ctx = await startCtx();
  try {
    const repo = new LeasesRepository(ctx.db);
    const at = (minutes: number): string =>
      new Date(Date.parse('2026-09-19T00:00:00.000Z') + minutes * 60_000).toISOString();
    const claim = (holder: string, priority: 'cwd' | 'side', minutes: number) =>
      repo.claim({resource: REPO, holder, holderKind: 'agent', priority, now: at(minutes)});

    const dead = claim('nuke/dead', 'cwd', 0);
    t.equal(dead.status, 'claimed');
    const deadToken = dead.status === 'claimed' ? dead.lease.claimToken : null;
    t.equal(claim('nuke/next', 'cwd', 59).status, 'conflict', 'inside the hour it holds');
    t.equal(repo.renew(REPO, 'nuke/dead', deadToken, undefined, at(30)).status, 'ok');
    t.equal(claim('nuke/next', 'cwd', 89).status, 'conflict', 'a renew restarts the hour');
    t.equal(claim('croc/side', 'side', 95).status, 'conflict', 'a side claim gets no grace');

    const late = claim('nuke/next', 'cwd', 91);
    t.equal(late.status, 'preempted', 'past the hour a cwd claim takes it');
    const event = repo.events(REPO)[0]!;
    t.equal(event.event, 'preempted');
    t.deepEqual(JSON.parse(event.detail!), {
      prior_holder: 'nuke/dead',
      prior_kind: 'agent',
      unrenewed_since: at(30)
    });
  } finally {
    await stopCtx(ctx);
  }
});

test('leases: transfer is atomic and rewrites holder attributes', async t => {
  const ctx = await startCtx();
  try {
    const claim = await api(`${ctx.url}/leases/claim`, 'POST', {
      resource: REPO,
      holder: 'nuke/session-a',
      priority: 'cwd'
    });
    const denied = await api(`${ctx.url}/leases/transfer`, 'POST', {
      resource: REPO,
      holder: 'croc/session-x',
      to_holder: 'croc/session-x'
    });
    t.equal(denied.status, 409, 'only the holder transfers');
    const tokenless = await api(`${ctx.url}/leases/transfer`, 'POST', {
      resource: REPO,
      holder: 'nuke/session-a',
      to_holder: 'croc/session-x'
    });
    t.equal(tokenless.body.code, 'claim_token_mismatch', 'the holder transfers with its token');

    const toAgent = await api(`${ctx.url}/leases/transfer`, 'POST', {
      resource: REPO,
      holder: 'nuke/session-a',
      claim_token: claim.body.claim_token,
      to_holder: 'croc/session-x'
    });
    t.equal(toAgent.body.status, 'ok');
    const agentToken = toAgent.body.claim_token as string;
    t.ok(agentToken && agentToken !== claim.body.claim_token, 'the recipient gets a new token');
    const stale = await api(`${ctx.url}/leases/renew`, 'POST', {
      resource: REPO,
      holder: 'croc/session-x',
      claim_token: claim.body.claim_token
    });
    t.equal(stale.status, 409, "the transferor's token no longer works");

    const toHuman = await api(`${ctx.url}/leases/transfer`, 'POST', {
      resource: REPO,
      holder: 'croc/session-x',
      claim_token: agentToken,
      to_holder: 'eugene',
      to_kind: 'human'
    });
    t.equal(toHuman.body.status, 'ok');
    t.equal(toHuman.body.lease.holder, 'eugene');
    t.equal(toHuman.body.lease.expires_at, null, 'transfer-to-human drops expiry');
    t.equal(toHuman.body.lease.priority, null, 'transfer-to-human drops priority');
    t.equal(toHuman.body.claim_token, undefined, 'a human lease carries no token');

    const events = await api(
      `${ctx.url}/leases/events?resource=${encodeURIComponent(REPO)}`,
      'GET'
    );
    t.equal(events.body.items[0].event, 'transferred', 'transfer logged, newest first');
    const humanRenew = await api(`${ctx.url}/leases/renew`, 'POST', {
      resource: REPO,
      holder: 'eugene'
    });
    t.equal(humanRenew.body.status, 'ok', 'the operator acts by name');
  } finally {
    await stopCtx(ctx);
  }
});

test('leases: force-release is the operator hatch', async t => {
  const ctx = await startCtx();
  try {
    await api(`${ctx.url}/leases/claim`, 'POST', {
      resource: REPO,
      holder: 'nuke/session-a',
      priority: 'cwd'
    });
    const plain = await api(`${ctx.url}/leases/release`, 'POST', {
      resource: REPO,
      holder: 'someone-else'
    });
    t.equal(plain.status, 409, 'non-holder release refused');
    const forced = await api(`${ctx.url}/leases/release`, 'POST', {
      resource: REPO,
      holder: 'eugene',
      force: true
    });
    t.equal(forced.body.status, 'released', 'force-release succeeds');
  } finally {
    await stopCtx(ctx);
  }
});

test('leases: server start clears coordination state', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-leases-test-'));
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  const repo = new LeasesRepository(db);
  repo.claim({resource: REPO, holder: 'stale/session', holderKind: 'agent', priority: 'side'});
  t.equal(repo.list().length, 1, 'lease present before start');
  const handle = await startServer({
    db,
    env: makeEnv(0, root),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  try {
    t.equal(repo.list().length, 0, 'clean slate on server start (D21)');
  } finally {
    await handle.close();
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

test('leases: unknown query and body-less claims are rejected', async t => {
  const ctx = await startCtx();
  try {
    const badQuery = await api(`${ctx.url}/leases?resorce=${encodeURIComponent(REPO)}`, 'GET');
    t.equal(badQuery.status, 400, 'typo query param named and rejected');
    const noBody = await api(`${ctx.url}/leases/claim`, 'POST', {holder: 'x'});
    t.equal(noBody.status, 400, 'missing resource rejected');
  } finally {
    await stopCtx(ctx);
  }
});
