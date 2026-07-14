import test from 'tape-six';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-claims';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

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

const seed = (root: string): void => {
  writeMd(
    root,
    'topics/alpha.md',
    [
      '---',
      'title: Alpha',
      'created: 2026-04-01',
      'updated: 2026-04-15',
      'tags:',
      '  - existing-tag',
      'agent:',
      '  summary: Alpha summary.',
      '  tags_suggested:',
      '    - batch-rejected',
      '---',
      'Alpha body links [[beta]] with enough context around it.',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'topics/beta.md',
    '---\ntitle: Beta\ncreated: 2026-04-10\nupdated: 2026-04-20\n---\nBeta body.\n'
  );
};

const startCtx = async (): Promise<ServerCtx> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-claims-test-'));
  seed(root);
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, root);
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

const createSuggestion = async (
  url: string,
  kind: string,
  payload: Record<string, unknown>,
  subjectId?: string
): Promise<string> => {
  const {status, body} = await api(`${url}/suggestions`, 'POST', {
    kind,
    payload,
    ...(subjectId !== undefined ? {subject_id: subjectId} : {})
  });
  if (status !== 201) throw new Error(`create failed: ${status} ${JSON.stringify(body)}`);
  return body.id as string;
};

const recordId = (db: DatabaseSync, filePath: string): string =>
  (
    db.prepare('SELECT record_id FROM records WHERE file_path = ?').get(filePath) as {
      record_id: string;
    }
  ).record_id;

test('claim: batch reservation, holder-scoped resolution, release', async t => {
  const ctx = await startCtx();
  try {
    const {url} = ctx;
    const ids = [];
    for (let i = 0; i < 3; ++i) {
      ids.push(await createSuggestion(url, 'contradiction_candidate', {note: `c${i}`}));
    }

    const claim = await api(`${url}/suggestions/claim`, 'POST', {
      kind: 'contradiction_candidate',
      holder: 'sweep-A',
      limit: 2
    });
    t.equal(claim.status, 200);
    t.equal(claim.body.claimed, 2);
    t.equal(claim.body.remaining_pending, 1);
    t.ok(typeof claim.body.claim_expires === 'string');
    for (const item of claim.body.items) {
      t.equal(item.status, 'claimed');
      t.equal(item.claimed_by, 'sweep-A');
      t.ok(item.claim_expires !== null);
    }

    // Claimed items are out of the pending pool; a second claimer gets the rest.
    const second = await api(`${url}/suggestions/claim`, 'POST', {
      kind: 'contradiction_candidate',
      holder: 'sweep-B',
      limit: 10
    });
    t.equal(second.body.claimed, 1);
    t.equal(second.body.remaining_pending, 0);

    const claimedId = claim.body.items[0].id as string;

    // Wrong holder → 409; no holder at all → 409.
    const wrong = await api(`${url}/suggestions/${claimedId}/accept`, 'POST', {
      resolved_by: 'sweep-B'
    });
    t.equal(wrong.status, 409);
    t.equal(wrong.body.code, 'claimed_by_other');
    t.equal(wrong.body.details.claimed_by, 'sweep-A');
    const anonymous = await api(`${url}/suggestions/${claimedId}/accept`, 'POST');
    t.equal(anonymous.status, 409);

    // The holder resolves; claim columns are cleared.
    const ok = await api(`${url}/suggestions/${claimedId}/accept`, 'POST', {
      resolved_by: 'sweep-A'
    });
    t.equal(ok.status, 200);
    t.equal(ok.body.status, 'accepted');
    t.equal(ok.body.resolved_by, 'sweep-A');
    t.equal(ok.body.claimed_by, null);
    t.equal(ok.body.claim_expires, null);

    // Reopen releases a claim without waiting for the TTL.
    const heldId = claim.body.items[1].id as string;
    const released = await api(`${url}/suggestions/${heldId}/reopen`, 'POST');
    t.equal(released.status, 200);
    t.equal(released.body.status, 'pending');
    t.equal(released.body.claimed_by, null);

    // Validation surface.
    const badKind = await api(`${url}/suggestions/claim`, 'POST', {kind: 'nope', holder: 'x'});
    t.equal(badKind.status, 400);
    const noHolder = await api(`${url}/suggestions/claim`, 'POST', {kind: 'new_tag'});
    t.equal(noHolder.status, 400);
    const badLimit = await api(`${url}/suggestions/claim`, 'POST', {
      kind: 'new_tag',
      holder: 'x',
      limit: 0
    });
    t.equal(badLimit.status, 400);
  } finally {
    await stopCtx(ctx);
  }
});

test('claim: expired claims lazily revert to pending', async t => {
  const ctx = await startCtx();
  try {
    const {url, db} = ctx;
    const id = await createSuggestion(url, 'contradiction_candidate', {note: 'ttl'});
    const claim = await api(`${url}/suggestions/claim`, 'POST', {
      kind: 'contradiction_candidate',
      holder: 'sweep-A'
    });
    t.equal(claim.body.claimed, 1);

    db.prepare(`UPDATE suggestions SET claim_expires = '2000-01-01T00:00:00Z' WHERE id = ?`).run(
      id
    );

    // Any suggestions touch reverts the expired claim.
    const list = await api(`${url}/suggestions?kind=contradiction_candidate&status=pending`, 'GET');
    t.equal(list.body.total, 1);
    t.equal(list.body.items[0].id, id);
    t.equal(list.body.items[0].status, 'pending');
    t.equal(list.body.items[0].claimed_by, null);

    // And the freed row is claimable by the next holder.
    const reclaim = await api(`${url}/suggestions/claim`, 'POST', {
      kind: 'contradiction_candidate',
      holder: 'sweep-B'
    });
    t.equal(reclaim.body.claimed, 1);
    t.equal(reclaim.body.items[0].claimed_by, 'sweep-B');
  } finally {
    await stopCtx(ctx);
  }
});

test('resolve-batch: plain kinds, per-item errors, claimed holder rule', async t => {
  const ctx = await startCtx();
  try {
    const {url} = ctx;
    const a = await createSuggestion(url, 'contradiction_candidate', {note: 'a'});
    const b = await createSuggestion(url, 'contradiction_candidate', {note: 'b'});
    const c = await createSuggestion(url, 'contradiction_candidate', {note: 'c'});
    await api(`${url}/suggestions/${c}/accept`, 'POST', {resolved_by: 'earlier'});
    const d = await createSuggestion(url, 'contradiction_candidate', {note: 'd'});
    await api(`${url}/suggestions/claim`, 'POST', {
      kind: 'contradiction_candidate',
      holder: 'other-session',
      limit: 1
    });
    // a is the oldest pending → now claimed by other-session.

    const res = await api(`${url}/suggestions/resolve-batch`, 'POST', {
      resolved_by: 'batch-1',
      items: [
        {id: a, decision: 'accept'},
        {id: b, decision: 'reject'},
        {id: c, decision: 'accept'},
        {id: 'no-such-id', decision: 'accept'},
        {id: d, decision: 'maybe'}
      ]
    });
    t.equal(res.status, 200);
    t.equal(res.body.accepted, 0);
    t.equal(res.body.rejected, 1);
    t.equal(res.body.failed, 4);

    const byId = new Map(res.body.results.map((r: any) => [r.id, r]));
    t.equal((byId.get(a) as any).error.code, 'claimed_by_other');
    t.equal((byId.get(b) as any).status, 'rejected');
    t.equal((byId.get(b) as any).resolved_by, 'batch-1');
    t.equal((byId.get(c) as any).error.code, 'already_resolved');
    t.equal((byId.get('no-such-id') as any).error.code, 'suggestion_not_found');
    t.equal((byId.get(d) as any).error.code, 'bad_item');

    // The claim holder can batch-resolve its own items.
    const held = await api(`${url}/suggestions/resolve-batch`, 'POST', {
      resolved_by: 'other-session',
      items: [{id: a, decision: 'accept'}]
    });
    t.equal(held.body.accepted, 1);
  } finally {
    await stopCtx(ctx);
  }
});

test('resolve-batch: tag_suggestion side effects settle on contact', async t => {
  const ctx = await startCtx();
  try {
    const {url, db, root} = ctx;
    const alpha = recordId(db, 'topics/alpha.md');

    // In the taxonomy so the accept's re-import realizes the tag and settles
    // the row on contact; an unknown tag falls back to the guarded flip.
    await api(`${url}/tags/taxonomy`, 'POST', {tag: 'batch-added'});
    const addId = await createSuggestion(
      url,
      'tag_suggestion',
      {tag: 'batch-added', record_id: alpha, file_path: 'topics/alpha.md'},
      alpha
    );
    const rejectId = (
      db
        .prepare(
          `SELECT id FROM suggestions
            WHERE kind = 'tag_suggestion' AND status = 'pending'
              AND json_extract(payload, '$.tag') = 'batch-rejected'`
        )
        .get() as {id: string} | undefined
    )?.id;
    t.ok(rejectId, 'import filed the tags_suggested candidate');

    const res = await api(`${url}/suggestions/resolve-batch`, 'POST', {
      resolved_by: 'batch-tags',
      items: [
        {id: addId, decision: 'accept'},
        {id: rejectId, decision: 'reject'}
      ]
    });
    t.equal(res.status, 200);
    t.equal(res.body.accepted, 1);
    t.equal(res.body.rejected, 1);

    const byId = new Map(res.body.results.map((r: any) => [r.id, r]));
    const acceptResult = byId.get(addId) as any;
    t.equal(acceptResult.side_effect.tag_added, true);
    // The re-import realized the tag, so resolution settled on contact.
    t.equal(acceptResult.resolved_by, 'tag-realized');
    const rejectResult = byId.get(rejectId) as any;
    t.equal(rejectResult.status, 'rejected');
    t.equal(rejectResult.side_effect.candidate_stripped, true);

    const onDisk = readFileSync(join(root, 'topics/alpha.md'), 'utf8');
    t.ok(onDisk.includes('batch-added'), 'accepted tag realized in FM');
    t.notOk(onDisk.includes('batch-rejected'), 'rejected candidate stripped from FM');
  } finally {
    await stopCtx(ctx);
  }
});

test('resolve-batch: edge_type accept pins the FM override', async t => {
  const ctx = await startCtx();
  try {
    const {url, db, root} = ctx;
    const alpha = recordId(db, 'topics/alpha.md');
    const beta = recordId(db, 'topics/beta.md');
    const edgeRow = db
      .prepare(
        `SELECT id FROM suggestions
          WHERE kind = 'edge_type' AND status = 'pending' AND subject_id = ?`
      )
      .get(alpha) as {id: string} | undefined;
    t.ok(edgeRow, 'import filed the default-cites review suggestion');
    const edgeId = edgeRow!.id;

    // Accept requires a typed value; "cites is correct" is a reject.
    const missing = await api(`${url}/suggestions/resolve-batch`, 'POST', {
      items: [{id: edgeId, decision: 'accept'}]
    });
    t.equal(missing.body.failed, 1);
    t.equal(missing.body.results[0].error.code, 'invalid_edge_type');
    const cites = await api(`${url}/suggestions/resolve-batch`, 'POST', {
      items: [{id: edgeId, decision: 'accept', edge_type: 'cites'}]
    });
    t.equal(cites.body.results[0].error.code, 'invalid_edge_type');

    const res = await api(`${url}/suggestions/resolve-batch`, 'POST', {
      resolved_by: 'batch-edges',
      items: [{id: edgeId, decision: 'accept', edge_type: 'applies-to'}]
    });
    t.equal(res.body.accepted, 1);
    const result = res.body.results[0];
    t.equal(result.side_effect.override_key, 'topics/beta');
    // The scoped edge pass settled the suggestion as an FM override.
    t.equal(result.resolved_by, 'fm-override');

    const onDisk = readFileSync(join(root, 'topics/alpha.md'), 'utf8');
    t.ok(/edges:/.test(onDisk) && /topics\/beta: applies-to/.test(onDisk));
    const typed = db
      .prepare('SELECT type FROM edges WHERE from_id = ? AND to_id = ?')
      .get(alpha, beta) as {type: string} | undefined;
    t.equal(typed?.type, 'applies-to');
  } finally {
    await stopCtx(ctx);
  }
});
