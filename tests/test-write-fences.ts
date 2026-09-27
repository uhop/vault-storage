import test from 'tape-six';
import {existsSync, mkdtempSync, readdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {HandoffsRepository} from '../src/records/handoffs.ts';
import {LeasesRepository} from '../src/records/leases.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer} from '../src/server/server.ts';

// D69: every read-check-write is fenced on the row as read. A second writer is
// simulated by a proxy that runs a competing write the moment the fenced
// statement executes — after the read, before the write.

const bind = (target: object, prop: string | symbol): unknown => {
  const value = Reflect.get(target, prop, target);
  return typeof value === 'function' ? value.bind(target) : value;
};

/** `times` competing writes, one per matching statement run; `after` runs once it has. */
const interlope = (
  db: DatabaseSync,
  match: RegExp,
  write: () => void,
  times = 1,
  after?: () => void
): DatabaseSync => {
  let left = times;
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== 'prepare') return bind(target, prop);
      return (sql: string) => {
        const stmt = target.prepare(sql);
        if (!match.test(sql)) return stmt;
        return new Proxy(stmt, {
          get(s, p) {
            if (p !== 'run') return bind(s, p);
            return (...args: unknown[]) => {
              if (left <= 0) return (s.run as (...a: unknown[]) => unknown)(...args);
              --left;
              write();
              const result = (s.run as (...a: unknown[]) => unknown)(...args);
              after?.();
              return result;
            };
          }
        });
      };
    }
  });
};

const freshDb = (): DatabaseSync => {
  const db = openDatabase({path: ':memory:'});
  runMigrations(db);
  return db;
};

const T0 = '2026-09-27T10:00:00.000Z';
const T1 = '2026-09-27T10:00:01.000Z';
const T2 = '2026-09-27T10:00:02.000Z';
const R = 'repo:github.com/uhop/example';

test('lease fences: a lost race re-decides against the fresh row', async t => {
  const db = freshDb();
  try {
    await t.test('claim of a free resource loses to an insert', t => {
      new LeasesRepository(db).clearAll();
      const other = new LeasesRepository(db);
      const repo = new LeasesRepository(
        interlope(db, /^\s*INSERT INTO leases \(/, () =>
          other.claim({resource: R, holder: 'b/1', holderKind: 'agent', priority: 'cwd', now: T0})
        )
      );
      const out = repo.claim({
        resource: R,
        holder: 'a/1',
        holderKind: 'agent',
        priority: 'side',
        now: T0
      });
      t.equal(out.status, 'conflict', 'the side claim yields to the cwd lease that got in first');
      t.equal(other.get(R, T0)?.holder, 'b/1', 'the winner keeps it');
    });

    await t.test('preemption loses to a human claim', t => {
      new LeasesRepository(db).clearAll();
      const other = new LeasesRepository(db);
      other.claim({resource: R, holder: 'b/1', holderKind: 'agent', priority: 'side', now: T0});
      const repo = new LeasesRepository(
        interlope(db, /^\s*UPDATE leases\s+SET holder = \?/, () =>
          other.claim({resource: R, holder: 'eugene', holderKind: 'human', now: T1})
        )
      );
      const out = repo.claim({
        resource: R,
        holder: 'a/1',
        holderKind: 'agent',
        priority: 'cwd',
        now: T1
      });
      t.equal(out.status, 'conflict', 'the operator is not preempted');
      t.equal(other.get(R, T1)?.holder, 'eugene');
    });

    await t.test('re-claim loses to a fresh claim under the same name', t => {
      new LeasesRepository(db).clearAll();
      const other = new LeasesRepository(db);
      const first = other.claim({
        resource: R,
        holder: 'a/1',
        holderKind: 'agent',
        priority: 'side',
        now: T0
      });
      const token = first.status === 'claimed' ? first.lease.claimToken : null;
      const repo = new LeasesRepository(
        interlope(db, /^\s*UPDATE leases\s+SET holder = \?/, () => {
          other.release(R, 'a/1', token, false, T1);
          other.claim({resource: R, holder: 'a/1', holderKind: 'agent', priority: 'side', now: T1});
        })
      );
      const out = repo.claim({
        resource: R,
        holder: 'a/1',
        holderKind: 'agent',
        priority: 'side',
        claimToken: token ?? undefined,
        now: T1
      });
      t.equal(out.status, 'token_mismatch', 'the old token does not renew the new claim');
    });

    for (const op of ['renew', 'release', 'transfer'] as const) {
      await t.test(`${op} loses to a re-claim`, t => {
        new LeasesRepository(db).clearAll();
        const other = new LeasesRepository(db);
        const first = other.claim({
          resource: R,
          holder: 'a/1',
          holderKind: 'agent',
          priority: 'side',
          now: T0
        });
        const token = first.status === 'claimed' ? first.lease.claimToken : null;
        const repo = new LeasesRepository(
          interlope(
            db,
            /^\s*(UPDATE|DELETE FROM) leases\s+(SET|WHERE resource = \? AND holder)/,
            () =>
              other.claim({
                resource: R,
                holder: 'b/1',
                holderKind: 'agent',
                priority: 'cwd',
                now: T1
              })
          )
        );
        const out =
          op === 'renew'
            ? repo.renew(R, 'a/1', token, undefined, T1)
            : op === 'release'
              ? repo.release(R, 'a/1', token, false, T1)
              : repo.transfer(R, 'a/1', token, {holder: 'eugene', holderKind: 'human'}, T1);
        t.equal(out.status, 'not_holder', 'reported against the fresh row');
        t.equal(other.get(R, T1)?.holder, 'b/1', 'the preempting lease is untouched');
        const events = other.events(R).map(e => e.event);
        t.notOk(
          events.includes(
            op === 'transfer' ? 'transferred' : op === 'renew' ? 'renewed' : 'released'
          ),
          'no event for a write that did not happen'
        );
      });
    }

    await t.test('the redo is bounded', t => {
      new LeasesRepository(db).clearAll();
      const other = new LeasesRepository(db);
      const first = other.claim({
        resource: R,
        holder: 'a/1',
        holderKind: 'agent',
        priority: 'side',
        now: T0
      });
      const token = first.status === 'claimed' ? first.lease.claimToken : null;
      const rekey = db.prepare('UPDATE leases SET claim_token = ? WHERE resource = ?');
      // A writer that always lands between our read and our write, then puts the row back.
      const repo = new LeasesRepository(
        interlope(
          db,
          /^\s*UPDATE leases SET renewed_at/,
          () => rekey.run('elsewhere', R),
          Infinity,
          () => rekey.run(token, R)
        )
      );
      t.throws(
        () => repo.renew(R, 'a/1', token, undefined, T1),
        /lost 3 races/,
        'a writer that always wins surfaces as an error'
      );
    });

    await t.test('expiry skips a lease renewed in the gap', t => {
      new LeasesRepository(db).clearAll();
      const other = new LeasesRepository(db);
      other.claim({
        resource: R,
        holder: 'a/1',
        holderKind: 'agent',
        priority: 'side',
        ttlSeconds: 60,
        now: T0
      });
      const later = '2026-09-27T10:05:00.000Z';
      const repo = new LeasesRepository(
        interlope(db, /^\s*DELETE FROM leases\s+WHERE resource = \? AND holder/, () =>
          db
            .prepare('UPDATE leases SET renewed_at = ?, expires_at = ? WHERE resource = ?')
            .run(later, '2026-09-27T14:05:00.000Z', R)
        )
      );
      t.equal(repo.expireLazy(later), 0, 'nothing dropped');
      t.equal(other.get(R, later)?.holder, 'a/1', 'the renewed lease stands');
      t.notOk(
        other
          .events(R)
          .map(e => e.event)
          .includes('expired'),
        'no expiry logged'
      );
    });
  } finally {
    db.close();
  }
});

const spoolHas = (root: string, name: string): boolean => {
  const dir = join(root, 'handoff');
  if (!existsSync(dir)) return false;
  return (readdirSync(dir, {recursive: true}) as string[]).some(p => p.endsWith(name));
};

test('handoff fences: a lost race re-decides against the fresh row', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-fences-test-'));
  const db = freshDb();
  const other = new HandoffsRepository(db, root);
  const racing = (write: () => void): HandoffsRepository =>
    new HandoffsRepository(interlope(db, /^\s*UPDATE handoffs/, write), root);
  let n = 0;
  const create = (): string =>
    other.create({
      idempotencyKey: `k-${++n}`,
      project: 'example',
      to: R,
      kind: 'apply-patch',
      from: {host: 'mba', session: 's'},
      body: 'Apply the patch.',
      now: T0
    }).handoff.id;
  const claimAt = (id: string, holder: string, at: string, ttl?: number): string | null => {
    const out = other.claim(id, holder, null, ttl, at);
    return out.status === 'claimed' ? out.handoff.claimToken : null;
  };
  try {
    await t.test('claim loses to another claim', t => {
      const id = create();
      const repo = racing(() => claimAt(id, 'b/1', T1));
      t.equal(repo.claim(id, 'a/1', null, undefined, T1).status, 'claimed_by_other');
      t.equal(other.get(id, T1)?.claimedBy, 'b/1', 'the first claim stands');
    });

    await t.test('a renew loses to a return', t => {
      const id = create();
      const token = claimAt(id, 'a/1', T0);
      const repo = racing(() => other.resolve(id, 'a/1', token, 'returned', undefined, 'redo', T1));
      t.equal(repo.claim(id, 'a/1', token, undefined, T1).status, 'not_open');
    });

    await t.test('resolve loses to a resolve', t => {
      const id = create();
      const token = claimAt(id, 'a/1', T0);
      const repo = racing(() =>
        other.resolve(id, 'a/1', token, 'returned', undefined, 'first', T1)
      );
      t.equal(
        repo.resolve(id, 'a/1', token, 'done', undefined, undefined, T1).status,
        'not_claimed'
      );
      t.equal(other.get(id, T1)?.status, 'returned', 'the first verdict stands');
    });

    await t.test('resubmit loses to a resubmit', t => {
      const id = create();
      const token = claimAt(id, 'a/1', T0);
      other.resolve(id, 'a/1', token, 'returned', undefined, 'redo', T0);
      const repo = racing(() => other.resubmit(id, {body: 'first'}, T1));
      t.equal(repo.resubmit(id, {body: 'second'}, T1).status, 'not_returned');
      t.equal(other.get(id, T1)?.body, 'first');
    });

    await t.test('verify and note both land when they race', t => {
      const id = create();
      const repo = racing(() => other.note(id, 'c', 'raced', T1));
      const out = repo.verify(id, {check: 'test', sha: 'abc1234', exit: 0, by: 'a'}, T2);
      t.equal(out.status, 'ok');
      const after = other.get(id, T2);
      t.equal(after?.notes.length, 1, 'the note is kept');
      t.equal(after?.verifications.length, 1, 'the verification is appended');

      const id2 = create();
      const repo2 = racing(() =>
        other.verify(id2, {check: 'lint', sha: 'abc1234', exit: 0, by: 'c'}, T1)
      );
      t.equal(repo2.note(id2, 'a', 'mine', T2).status, 'ok');
      const after2 = other.get(id2, T2);
      t.equal(after2?.verifications.length, 1, 'the verification is kept');
      t.equal(after2?.notes.length, 1, 'the note is appended');
    });

    await t.test('an artifact upload loses to a verdict and writes no file', t => {
      const id = create();
      const token = claimAt(id, 'a/1', T0);
      const repo = racing(() =>
        other.resolve(id, 'a/1', token, 'rejected', {why: 'no'}, undefined, T1)
      );
      const out = repo.putArtifact(id, 'patch', Buffer.from('From x\n'), 'a', T1);
      t.equal(out.status, 'resolved');
      t.notOk(spoolHas(root, `${id}.patch`), 'no artifact in the spool');
    });

    await t.test('claim expiry skips a claim renewed in the gap', t => {
      const id = create();
      claimAt(id, 'a/1', T0, 60);
      const later = '2026-09-27T10:05:00.000Z';
      const renewed = '2026-09-27T10:35:00.000Z';
      const repo = racing(() =>
        db
          .prepare('UPDATE handoffs SET claim_expires = ?, updated = ? WHERE id = ?')
          .run(renewed, later, id)
      );
      t.equal(repo.expireLazy(later), 0, 'nothing reverted');
      const after = other.get(id, later);
      t.equal(after?.status, 'claimed', 'the renewed claim stands');
      t.notOk(
        other
          .events(id)
          .map(e => e.event)
          .includes('claim_expired'),
        'no expiry logged'
      );
      t.ok(existsSync(join(root, 'handoff', 'example', 'claimed', `${id}.md`)), 'spool unmoved');
    });
  } finally {
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
});

const makeEnv = (dataPath: string): ServerEnv => ({
  vaultDataPath: dataPath,
  vaultIngestPath: null,
  vaultDbPath: ':memory:',
  apiToken: 'test-token-fences',
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

test('suggestion fences: a settle or claim never takes another writer’s row', async t => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-fences-test-'));
  const raw = freshDb();
  let race: (() => void) | null = null;
  const db = interlope(
    raw,
    /UPDATE suggestions\s+SET status = (\?, resolved_at|'claimed')/,
    () => {
      const r = race;
      race = null;
      r?.();
    },
    Infinity
  );
  const handle = await startServer({
    db,
    env: makeEnv(root),
    schemaVersion: runMigrations(raw).current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const url = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
  const api = async (path: string, body?: unknown): Promise<{status: number; body: any}> => {
    const res = await fetch(url + path, {
      method: 'POST',
      headers: {Authorization: 'Bearer test-token-fences', 'Content-Type': 'application/json'},
      body: JSON.stringify(body ?? {})
    });
    return {status: res.status, body: await res.json()};
  };
  let n = 0;
  const pending = (): string => {
    const id = `sug-${String(++n).padStart(3, '0')}`;
    raw
      .prepare(
        `INSERT INTO suggestions (id, kind, subject_id, payload, status, created)
         VALUES (?, 'duplicate', NULL, '{}', 'pending', ?)`
      )
      .run(id, `2026-09-27T10:00:${String(n).padStart(2, '0')}.000Z`);
    return id;
  };
  const steal = (id: string) => () =>
    raw
      .prepare(
        `UPDATE suggestions SET status = 'claimed', claimed_by = 'b', claim_token = 'tb',
                claimed_at = ?, claim_expires = ? WHERE id = ?`
      )
      .run(T0, '2099-01-01T00:00:00.000Z', id);
  const claimOne = async (): Promise<{id: string; token: string}> => {
    const id = pending();
    const out = await api('/suggestions/claim', {kind: 'duplicate', holder: 'a', limit: 1});
    return {id, token: out.body.claim_token};
  };
  const statusOf = (id: string) =>
    raw.prepare('SELECT status, claimed_by FROM suggestions WHERE id = ?').get(id) as {
      status: string;
      claimed_by: string | null;
    };
  try {
    await t.test('a single resolve loses to a re-claim', async t => {
      const {id, token} = await claimOne();
      race = steal(id);
      const out = await api(`/suggestions/${id}/reject`, {claim_token: token});
      t.equal(out.status, 409);
      t.equal(out.body.error?.code ?? out.body.code, 'conflict');
      t.deepEqual(statusOf(id), {status: 'claimed', claimed_by: 'b'}, 'the other claim stands');
    });

    await t.test('a batch item loses to a re-claim', async t => {
      const {id, token} = await claimOne();
      race = steal(id);
      const out = await api('/suggestions/resolve-batch', {
        claim_token: token,
        items: [{id, decision: 'reject'}]
      });
      t.equal(out.body.failed, 1);
      t.equal(out.body.results[0].error.code, 'conflict');
      t.deepEqual(statusOf(id), {status: 'claimed', claimed_by: 'b'});
    });

    await t.test('a settle that raced ahead still answers 200', async t => {
      const {id, token} = await claimOne();
      race = () =>
        raw
          .prepare(
            `UPDATE suggestions SET status = 'accepted', resolved_at = ?, claimed_by = NULL,
                    claimed_at = NULL, claim_expires = NULL, claim_token = NULL WHERE id = ?`
          )
          .run(T0, id);
      const out = await api(`/suggestions/${id}/accept`, {claim_token: token});
      t.equal(out.status, 200);
      t.equal(out.body.status, 'accepted');
    });

    await t.test('a claim does not report rows another writer took', async t => {
      raw.exec(`UPDATE suggestions SET status = 'rejected' WHERE status != 'rejected'`);
      const ids = [pending(), pending(), pending()];
      race = steal(ids[0]!);
      const out = await api('/suggestions/claim', {kind: 'duplicate', holder: 'a', limit: 3});
      t.equal(out.body.claimed, 2);
      t.deepEqual(
        out.body.items.map((i: {id: string}) => i.id),
        ids.slice(1),
        'only the rows this claim took'
      );
    });
  } finally {
    await handle.close();
    raw.close();
    rmSync(root, {recursive: true, force: true});
  }
});
