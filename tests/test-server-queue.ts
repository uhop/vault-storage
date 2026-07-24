import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {QueueItemsRepository} from '../src/queue/repo.ts';
import {syncQueueFile} from '../src/queue/sync.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-queue';
const FM = ['---', 'title: x — Queue', 'type: project', '---', ''].join('\n');

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

const fetchJson = async (
  url: string,
  init: RequestInit = {}
): Promise<{status: number; body: unknown}> => {
  const res = await fetch(url, init);
  const text = await res.text();
  const body = text.length === 0 ? null : JSON.parse(text);
  return {status: res.status, body};
};

const writeQueueFile = (
  root: string,
  project: string,
  basename: string,
  content: string
): string => {
  const dir = join(root, 'projects', project);
  mkdirSync(dir, {recursive: true});
  writeFileSync(join(dir, basename), content);
  return `projects/${project}/${basename}`;
};

const withServer = async (
  seed: (db: ReturnType<typeof openDatabase>, root: string) => void,
  fn: (url: string, root: string) => Promise<void>
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), 'vault-server-queue-'));
  mkdirSync(join(root, 'projects'), {recursive: true});
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  seed(db, root);
  const handle = await startServer({
    db,
    env: makeEnv(0, root),
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const url = `http://127.0.0.1:${port}`;
  try {
    await fn(url, root);
  } finally {
    await handle.close();
    db.close();
    rmSync(root, {recursive: true, force: true});
  }
};

const seedFleet = (db: ReturnType<typeof openDatabase>, root: string): void => {
  const repo = new QueueItemsRepository(db);
  writeQueueFile(
    root,
    'alpha',
    'queue.md',
    FM +
      [
        '## Active',
        '',
        '- **A-active.** in flight',
        '',
        '## Backlog',
        '',
        '### Priority +2',
        '',
        '- **A-top.** highest',
        '### Priority +1',
        '',
        '- **A-boost.** boosted',
        '### Priority 0',
        '',
        '- **A-normal.** normal',
        '',
        '## Watching',
        '',
        '- **A-watch.** upstream'
      ].join('\n')
  );
  writeQueueFile(
    root,
    'alpha',
    'queue-archive.md',
    FM +
      [
        '## 2026-05-13',
        '',
        '- **A-shipped.** shipped in commit abc',
        '## 2026-04-01',
        '',
        '- **A-old.** rejected per design'
      ].join('\n')
  );
  writeQueueFile(
    root,
    'bravo',
    'queue.md',
    FM +
      [
        '## Backlog',
        '',
        '### Priority +1',
        '',
        '- **B-boost.** also boosted',
        '### Priority -1',
        '',
        '- **B-demoted.** later'
      ].join('\n')
  );
  syncQueueFile(repo, 'projects/alpha/queue.md', root, '2026-05-13T12:00:00Z');
  syncQueueFile(repo, 'projects/alpha/queue-archive.md', root, '2026-05-13T12:00:00Z');
  syncQueueFile(repo, 'projects/bravo/queue.md', root, '2026-05-13T12:00:00Z');
};

const authHeader = {Authorization: `Bearer ${TEST_TOKEN}`};

test('GET /queue/top — fleet-wide priority ordering, default limit', async t => {
  await withServer(seedFleet, async url => {
    const {status, body} = await fetchJson(`${url}/queue/top`, {headers: authHeader});
    t.equal(status, 200);
    const payload = body as {
      limit: number;
      count: number;
      items: Array<{title: string; priority: number; project: string}>;
    };
    t.equal(payload.limit, 20, 'default limit 20');
    t.deepEqual(
      payload.items.map(it => [it.priority, it.project, it.title]),
      [
        [2, 'alpha', 'A-top.'],
        [1, 'alpha', 'A-boost.'],
        [1, 'bravo', 'B-boost.'],
        [0, 'alpha', 'A-active.'],
        [0, 'alpha', 'A-normal.'],
        [0, 'alpha', 'A-watch.'],
        [-1, 'bravo', 'B-demoted.']
      ]
    );
  });
});

test('GET /queue/top?limit=3 — limits result count', async t => {
  await withServer(seedFleet, async url => {
    const {status, body} = await fetchJson(`${url}/queue/top?limit=3`, {headers: authHeader});
    t.equal(status, 200);
    const payload = body as {limit: number; count: number; items: unknown[]};
    t.equal(payload.limit, 3);
    t.equal(payload.count, 3);
    t.equal(payload.items.length, 3);
  });
});

test('GET /queue/top?limit=bogus — 400', async t => {
  await withServer(seedFleet, async url => {
    const {status} = await fetchJson(`${url}/queue/top?limit=-1`, {headers: authHeader});
    t.equal(status, 400);
  });
});

test('GET /queue/by-section/backlog — fleet-wide', async t => {
  await withServer(seedFleet, async url => {
    const {status, body} = await fetchJson(`${url}/queue/by-section/backlog`, {
      headers: authHeader
    });
    t.equal(status, 200);
    const payload = body as {section: string; items: Array<{title: string}>};
    t.equal(payload.section, 'backlog');
    t.deepEqual(
      payload.items.map(it => it.title),
      ['A-top.', 'A-boost.', 'B-boost.', 'A-normal.', 'B-demoted.']
    );
  });
});

test('GET /queue/by-section/bogus — 400', async t => {
  await withServer(seedFleet, async url => {
    const {status} = await fetchJson(`${url}/queue/by-section/nope`, {headers: authHeader});
    t.equal(status, 400);
  });
});

test('GET /queue/by-priority/1 — fleet-wide Backlog at priority 1', async t => {
  await withServer(seedFleet, async url => {
    const {status, body} = await fetchJson(`${url}/queue/by-priority/1`, {headers: authHeader});
    t.equal(status, 200);
    const payload = body as {priority: number; items: Array<{title: string; project: string}>};
    t.equal(payload.priority, 1);
    t.deepEqual(
      payload.items.map(it => [it.project, it.title]),
      [
        ['alpha', 'A-boost.'],
        ['bravo', 'B-boost.']
      ]
    );
  });
});

test('GET /queue/by-priority/-1 — handles negative integer', async t => {
  await withServer(seedFleet, async url => {
    const {status, body} = await fetchJson(`${url}/queue/by-priority/-1`, {headers: authHeader});
    t.equal(status, 200);
    const payload = body as {priority: number; items: Array<{title: string}>};
    t.equal(payload.priority, -1);
    t.deepEqual(
      payload.items.map(it => it.title),
      ['B-demoted.']
    );
  });
});

test('GET /queue/by-priority/abc — 400', async t => {
  await withServer(seedFleet, async url => {
    const {status} = await fetchJson(`${url}/queue/by-priority/abc`, {headers: authHeader});
    t.equal(status, 400);
  });
});

test('GET /queue/projects/{name} — open items only, section-grouped order', async t => {
  await withServer(seedFleet, async url => {
    const {status, body} = await fetchJson(`${url}/queue/projects/alpha`, {headers: authHeader});
    t.equal(status, 200);
    const payload = body as {
      project: string;
      items: Array<{section: string; title: string; priority: number}>;
    };
    t.equal(payload.project, 'alpha');
    t.deepEqual(
      payload.items.map(it => [it.section, it.priority, it.title]),
      [
        ['active', 0, 'A-active.'],
        ['backlog', 2, 'A-top.'],
        ['backlog', 1, 'A-boost.'],
        ['backlog', 0, 'A-normal.'],
        ['watching', 0, 'A-watch.']
      ],
      'active first; backlog by priority desc; watching last'
    );
  });
});

test('GET /queue/projects/{name}/archive — closed_at DESC with nulls last', async t => {
  await withServer(seedFleet, async url => {
    const {status, body} = await fetchJson(`${url}/queue/projects/alpha/archive`, {
      headers: authHeader
    });
    t.equal(status, 200);
    const payload = body as {
      project: string;
      items: Array<{closed_at: string | null; title: string; close_reason: string | null}>;
    };
    t.deepEqual(
      payload.items.map(it => [it.closed_at, it.close_reason, it.title]),
      [
        ['2026-05-13', 'shipped', 'A-shipped.'],
        ['2026-04-01', 'rejected', 'A-old.']
      ]
    );
  });
});

test('POST /maintenance/reindex-queues — populates from disk', async t => {
  await withServer(
    (_db, root) => {
      writeQueueFile(root, 'gamma', 'queue.md', FM + ['## Backlog', '', '- **C.** c'].join('\n'));
      // No watcher and no seed: table is empty until reindex runs.
    },
    async url => {
      // Pre-condition: empty.
      const before = await fetchJson(`${url}/queue/top`, {headers: authHeader});
      t.equal((before.body as {count: number}).count, 0);

      const {status, body} = await fetchJson(`${url}/maintenance/reindex-queues`, {
        method: 'POST',
        headers: authHeader
      });
      t.equal(status, 200);
      const summary = body as {
        projectsScanned: number;
        filesProcessed: number;
        inserted: number;
        deleted: number;
      };
      t.equal(summary.projectsScanned, 1);
      t.equal(summary.filesProcessed, 1);
      t.equal(summary.inserted, 1);

      // Post-condition: visible via fleet endpoint.
      const after = await fetchJson(`${url}/queue/top`, {headers: authHeader});
      const payload = after.body as {items: Array<{project: string; title: string}>};
      t.deepEqual(
        payload.items.map(it => [it.project, it.title]),
        [['gamma', 'C.']]
      );
    }
  );
});

test('Unauthenticated requests are rejected', async t => {
  await withServer(seedFleet, async url => {
    const {status} = await fetchJson(`${url}/queue/top`);
    t.equal(status, 401);
  });
});

const seedBlockedFleet = (db: ReturnType<typeof openDatabase>, root: string): void => {
  const repo = new QueueItemsRepository(db);
  writeQueueFile(
    root,
    'charlie',
    'queue.md',
    FM +
      [
        '## Backlog',
        '',
        '- **C-free.** nothing in the way',
        '- **C-blocked.** waits on the free one',
        '  - blocked-by: C-free.',
        '- **C-done-dep.** blocker already shipped',
        '  - blocked-by: C-shipped.',
        '- **C-typo.** ref points nowhere',
        '  - blocked-by: nonexistent thing'
      ].join('\n')
  );
  writeQueueFile(
    root,
    'charlie',
    'queue-archive.md',
    FM + ['## 2026-07-01', '', '- **C-shipped.** shipped in commit xyz'].join('\n')
  );
  writeQueueFile(
    root,
    'delta',
    'queue.md',
    FM +
      ['## Backlog', '', '- **D-cross.** waits on charlie', '  - blocked-by: charlie/C-free.'].join(
        '\n'
      )
  );
  syncQueueFile(repo, 'projects/charlie/queue.md', root, '2026-07-23T12:00:00Z');
  syncQueueFile(repo, 'projects/charlie/queue-archive.md', root, '2026-07-23T12:00:00Z');
  syncQueueFile(repo, 'projects/delta/queue.md', root, '2026-07-23T12:00:00Z');
};

test('GET /queue/ready — unblocked backlog only; closed blockers release', async t => {
  await withServer(seedBlockedFleet, async url => {
    const {status, body} = await fetchJson(`${url}/queue/ready`, {headers: authHeader});
    t.equal(status, 200);
    const payload = body as {count: number; items: Array<{title: string; blocked_by: string[]}>};
    t.deepEqual(
      payload.items.map(it => it.title),
      ['C-free.', 'C-done-dep.'],
      'open blocker and unresolved ref block; archived blocker releases'
    );
    t.deepEqual(payload.items[1]?.blocked_by, ['C-shipped.'], 'raw refs surface on items');
  });
});

test('GET /queue/ready?project= — scoped; cross-project blockage respected', async t => {
  await withServer(seedBlockedFleet, async url => {
    const {status, body} = await fetchJson(`${url}/queue/ready?project=delta`, {
      headers: authHeader
    });
    t.equal(status, 200);
    const payload = body as {project: string; count: number};
    t.equal(payload.project, 'delta');
    t.equal(payload.count, 0, 'D-cross. is blocked by an open item in charlie');
  });
});

test('GET /queue/blocked — per-ref detail with states and targets', async t => {
  await withServer(seedBlockedFleet, async url => {
    const {status, body} = await fetchJson(`${url}/queue/blocked`, {headers: authHeader});
    t.equal(status, 200);
    const payload = body as {
      count: number;
      items: Array<{
        title: string;
        in_cycle: boolean;
        blockers: Array<{ref: string; state: string; target?: {project: string; title: string}}>;
      }>;
    };
    const byTitle = new Map(payload.items.map(it => [it.title, it]));
    t.deepEqual([...byTitle.keys()].sort(), ['C-blocked.', 'C-typo.', 'D-cross.']);
    t.equal(byTitle.get('C-blocked.')?.blockers[0]?.state, 'open');
    t.equal(byTitle.get('C-typo.')?.blockers[0]?.state, 'unresolved');
    const cross = byTitle.get('D-cross.')?.blockers[0];
    t.equal(cross?.state, 'open');
    t.equal(cross?.target?.project, 'charlie');
    t.equal(byTitle.get('C-blocked.')?.in_cycle, false);
  });
});

test('GET /queue/ready — unknown query parameter is a loud 400', async t => {
  await withServer(seedBlockedFleet, async url => {
    const {status, body} = await fetchJson(`${url}/queue/ready?projct=delta`, {
      headers: authHeader
    });
    t.equal(status, 400, 'typo`d filter fails instead of returning the fleet view');
    t.ok((body as {error: string}).error.includes('projct'), 'offender named');
  });
});
