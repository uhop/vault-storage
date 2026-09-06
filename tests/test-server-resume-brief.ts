import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import {QueueItemsRepository} from '../src/queue/repo.ts';
import {syncQueueFile} from '../src/queue/sync.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-brief';

const makeEnv = (port: number, vaultDataPath: string): ServerEnv => ({
  vaultDataPath,
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

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const seed = (root: string): void => {
  writeMd(
    root,
    'projects/vs-demo/feedback.md',
    [
      '---',
      'title: vs-demo — Feedback',
      'type: project',
      'created: 2026-07-01',
      'updated: 2026-07-09',
      '---',
      'Rules the brief must never inline.',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'logs/2026-07-22-last-session.md',
    [
      '---',
      'title: Last session',
      'type: log',
      'created: 2026-07-22',
      'updated: 2026-07-22',
      '---',
      'A long log body the brief must not carry.',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'logs/2026-05-31-stale-session.md',
    [
      '---',
      'title: Stale session',
      'type: log',
      'created: 2026-05-31',
      'updated: 2026-05-31',
      '---',
      'An old log that maintenance will touch.',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'logs/2026-06-15-archived-in-place.md',
    [
      '---',
      'title: Archived in place',
      'type: log',
      'created: 2026-06-15',
      'updated: 2026-08-29',
      'status: archived',
      '---',
      'Archived at its original path, never moved under archive/.',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'projects/vs-demo/queue.md',
    [
      '---',
      'title: vs-demo — Queue',
      'type: project',
      '---',
      '',
      '## Active',
      '',
      '- **Mid-flight thing.** in progress',
      '',
      '## Backlog',
      '',
      '- **Free item.** startable',
      '- **Stuck item.** waits',
      '  - blocked-by: Free item.',
      '',
      '## Watching',
      ''
    ].join('\n')
  );
  writeMd(
    root,
    'projects/vs-messy/queue.md',
    [
      '---',
      'title: vs-messy — Queue',
      'type: project',
      '---',
      '',
      '## Active',
      '',
      '- **Landed — SHIPPED 2026-09-01.** never moved to the archive',
      '',
      '## Backlog',
      '',
      '- **Open.** fine',
      '',
      '## Done',
      '',
      '- **Invented heading.** invisible to every queue view',
      '',
      '## Watching',
      ''
    ].join('\n')
  );
};

const withServer = async (
  fn: (url: string, db: ReturnType<typeof openDatabase>) => Promise<void>
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-resume-brief-'));
  seed(root);
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, root);
  const queueRepo = new QueueItemsRepository(db);
  syncQueueFile(queueRepo, 'projects/vs-demo/queue.md', root);
  syncQueueFile(queueRepo, 'projects/vs-messy/queue.md', root);
  const handle = await startServer({
    db,
    env: makeEnv(0, root),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`, db);
  } finally {
    await handle.close();
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
};

const fetchRaw = async (url: string): Promise<{status: number; raw: string}> => {
  const res = await fetch(url, {headers: {Authorization: `Bearer ${TEST_TOKEN}`}});
  return {status: res.status, raw: await res.text()};
};

test('GET /system/resume-brief — fleet shape, no bodies, small payload', async t => {
  await withServer(async url => {
    const {status, raw} = await fetchRaw(`${url}/system/resume-brief`);
    t.equal(status, 200);
    t.ok(raw.length < 1024, `payload stays brief (${raw.length} bytes)`);
    t.notOk(raw.includes('must not carry'), 'no log bodies');
    const body = JSON.parse(raw) as {
      lint: {ok: boolean; total_issues: number};
      suggestions_pending: number;
      workflow: {active: boolean; clarify_pending: number | null};
      latest_log: {file_path: string; title: string | null; updated: string};
      project: null;
    };
    t.equal(typeof body.lint.ok, 'boolean');
    t.equal(typeof body.suggestions_pending, 'number');
    t.equal(body.workflow.active, false, 'no agent-workflow surface seeded');
    t.equal(body.latest_log.file_path, 'logs/2026-07-22-last-session.md');
    t.equal(body.project, null, 'no project block without ?project=');
  });
});

test('GET /system/resume-brief?project= — queue counts + feedback pointer, still no bodies', async t => {
  await withServer(async url => {
    const {status, raw} = await fetchRaw(`${url}/system/resume-brief?project=vs-demo`);
    t.equal(status, 200);
    t.notOk(raw.includes('never inline'), 'feedback body not inlined');
    const body = JSON.parse(raw) as {
      project: {
        name: string;
        queue: {
          active: string[];
          backlog: number;
          ready: number;
          blocked: number;
          hygiene: string[];
        };
        feedback: {updated: string} | null;
      };
    };
    t.deepEqual(body.project.queue.active, ['Mid-flight thing.']);
    t.equal(body.project.queue.backlog, 2, 'two backlog items');
    t.equal(body.project.queue.ready, 1, 'only the unblocked one is ready');
    t.equal(body.project.queue.blocked, 1, 'the ref-carrying one is blocked');
    t.deepEqual(body.project.queue.hygiene, [], 'a clean queue carries no findings');
    t.equal(body.project.feedback?.updated, '2026-07-09');
  });
});

test('GET /system/resume-brief?project= — the project’s queue-hygiene findings, and only its own', async t => {
  await withServer(async url => {
    const {status, raw} = await fetchRaw(`${url}/system/resume-brief?project=vs-messy`);
    t.equal(status, 200);
    const body = JSON.parse(raw) as {
      lint: {ok: boolean; total_issues: number};
      project: {queue: {hygiene: string[]}};
    };
    const findings = body.project.queue.hygiene;
    t.equal(findings.length, 2, 'the shipped-but-open item and the invented heading');
    t.ok(
      findings.some(f =>
        /^Active "Landed — SHIPPED 2026-09-01.": completion marker 'SHIPPED'/.test(f)
      ),
      findings.join('\n')
    );
    t.ok(
      findings.some(f => /^## Done: 1 item under a non-schema H2/.test(f)),
      findings.join('\n')
    );
    t.notOk(raw.includes('Mid-flight'), 'the other project’s queue stays out of this block');
    t.equal(body.lint.ok, false, 'the fleet lint line counts them too');
  });
});

test('GET /system/resume-brief — validation is loud', async t => {
  await withServer(async url => {
    const unknown = await fetchRaw(`${url}/system/resume-brief?proejct=vs-demo`);
    t.equal(unknown.status, 400, 'unknown query param 400s');
    t.ok(unknown.raw.includes('proejct'), 'offender named');

    const badName = await fetchRaw(`${url}/system/resume-brief?project=Not%20Kebab`);
    t.equal(badName.status, 400, 'non-kebab project 400s');
  });
});

// A maintenance touch — a status flip, an enrichment write — re-stamps
// modified_at/updated without moving `created`. Before the 2026-09-01 fix both
// resume surfaces ordered on that touch and filtered archives by path only, so
// an old log marked archived in place came back as the newest session
// (observed 2026-08-29: three May logs above four born-enriched August ones).
// The brief reads the DB directly, so a touch here stands; the bundle reindexes
// first, which is why its fixture carries `status` in the file instead.
const touch = (
  db: ReturnType<typeof openDatabase>,
  path: string,
  patch: {status?: string; modifiedAt?: string}
): void => {
  if (patch.status !== undefined)
    db.prepare(`UPDATE records SET status = ? WHERE file_path = ?`).run(patch.status, path);
  if (patch.modifiedAt !== undefined)
    db.prepare(`UPDATE records SET updated = ?, modified_at = ? WHERE file_path = ?`).run(
      patch.modifiedAt.slice(0, 10),
      patch.modifiedAt,
      path
    );
};

test('GET /system/resume-brief — a fresh touch on an old log does not make it newest', async t => {
  await withServer(async (url, db) => {
    // Both stamps are pinned: import sets modified_at to now for every fixture,
    // so touching only the old log would leave it OLDER and the assertion would
    // pass against the very bug it targets.
    touch(db, 'logs/2026-07-22-last-session.md', {modifiedAt: '2026-07-22T10:00:00.000Z'});
    touch(db, 'logs/2026-05-31-stale-session.md', {modifiedAt: '2026-08-29T04:15:14.582Z'});
    const {status, raw} = await fetchRaw(`${url}/system/resume-brief`);
    t.equal(status, 200);
    const body = JSON.parse(raw) as {latest_log: {file_path: string} | null};
    t.equal(
      body.latest_log?.file_path,
      'logs/2026-07-22-last-session.md',
      'newest by created wins over the freshly-touched May log'
    );
  });
});

test('GET /system/resume-brief — a log archived in place is excluded, not just moved ones', async t => {
  await withServer(async (url, db) => {
    touch(db, 'logs/2026-07-22-last-session.md', {status: 'archived'});
    const {raw} = await fetchRaw(`${url}/system/resume-brief`);
    const body = JSON.parse(raw) as {latest_log: {file_path: string} | null};
    t.equal(
      body.latest_log?.file_path,
      'logs/2026-05-31-stale-session.md',
      'archiving the newest falls through to the next active log'
    );
  });
});

test('POST /system/resume-bundle — same selection rules, and they survive the reindex', async t => {
  await withServer(async url => {
    const res = await fetch(`${url}/system/resume-bundle?logs=5`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${TEST_TOKEN}`}
    });
    const body = (await res.json()) as {logs: {file_path: string}[]};
    t.equal(res.status, 200);
    t.deepEqual(
      body.logs.map(l => l.file_path),
      ['logs/2026-07-22-last-session.md', 'logs/2026-05-31-stale-session.md'],
      'archived-in-place log excluded; the rest ordered by created'
    );
  });
});

// A summary is a derived artifact; both resume surfaces say when it predates
// the body (2026-09-01: a resume relayed "newest, filed 2026-08-29" over a
// queue whose body held a newer item, while the same bundle counted the
// staleness suggestion anonymously).
test('resume brief + bundle — summary_stale flips when the body outruns its agent.summary', async t => {
  await withServer(async url => {
    const headers = {Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json'};
    const put = await fetch(`${url}/vault/projects/vs-demo/feedback.md`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        frontmatter: {agent: {summary: 'rules digest', derived_from_hash: 'auto'}},
        body: 'Rules the brief must never inline.\n'
      })
    });
    t.equal(put.status, 204, 'enriched with a server-stamped hash');

    const brief = async (): Promise<{updated: string; summary_stale: boolean} | null> => {
      const {raw} = await fetchRaw(`${url}/system/resume-brief?project=vs-demo`);
      return (
        JSON.parse(raw) as {project: {feedback: {updated: string; summary_stale: boolean} | null}}
      ).project.feedback;
    };
    const bundle = async (): Promise<{
      logs: Array<{summary: string | null; summary_stale: boolean}>;
      files: Record<string, {summary: string | null; summary_stale: boolean} | null>;
    }> => {
      const res = await fetch(`${url}/system/resume-bundle?project=vs-demo&logs=2`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${TEST_TOKEN}`}
      });
      const body = (await res.json()) as {
        logs: Array<{summary: string | null; summary_stale: boolean}>;
        project: {files: Record<string, {summary: string | null; summary_stale: boolean} | null>};
      };
      return {logs: body.logs, files: body.project.files};
    };

    t.equal((await brief())?.summary_stale, false, 'brief: fresh summary is not stale');
    const fresh = await bundle();
    t.equal(fresh.files['feedback']?.summary, 'rules digest', 'bundle ships the summary');
    t.equal(fresh.files['feedback']?.summary_stale, false, 'bundle: fresh summary is not stale');
    t.equal(fresh.files['queue']?.summary_stale, false, 'no summary at all is not stale either');
    t.ok(
      fresh.logs.every(l => l.summary === null && l.summary_stale === false),
      'unenriched logs carry the marker as false'
    );

    const edit = await fetch(`${url}/vault/edit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        path: 'projects/vs-demo/feedback.md',
        op: 'append',
        text: 'A rule added after the summary was derived.\n'
      })
    });
    t.equal(edit.status, 200, 'body appended, FM verbatim');

    t.equal(
      (await brief())?.summary_stale,
      true,
      'brief: the pointer says the summary predates the body'
    );
    const stale = await bundle();
    t.equal(stale.files['feedback']?.summary, 'rules digest', 'the old summary still ships');
    t.equal(stale.files['feedback']?.summary_stale, true, 'bundle: marked stale beside it');
  });
});
