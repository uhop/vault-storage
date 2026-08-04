import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {embedPending} from '../src/embeddings/embed-pass.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {importVault} from '../src/importer/import.ts';
import {EdgesRepository} from '../src/records/edges.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {startServer, type ServerHandle} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-context-pack';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setup = (): {root: string; cleanup: () => void} => {
  const root = mkdtempSync(join(tmpdir(), 'vault-storage-context-pack-test-'));
  return {root, cleanup: () => rmSync(root, {recursive: true, force: true})};
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
  db: DatabaseSync;
  handle: ServerHandle;
  url: string;
}

const startTestServer = async (vaultRoot: string): Promise<ServerCtx> => {
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  importVault(db, vaultRoot);
  const embedder = new FakeEmbedder();
  await embedPending(db, embedder);
  const handle = await startServer({
    db,
    env: makeEnv(0, vaultRoot),
    schemaVersion: migration.current,
    embedder
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return {db, handle, url: `http://127.0.0.1:${port}`};
};

const teardown = async ({db, handle}: ServerCtx): Promise<void> => {
  await handle.close();
  db.close();
};

const fetchAuthed = async (
  url: string,
  init: RequestInit = {}
): Promise<{status: number; body: unknown}> => {
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${TEST_TOKEN}`);
  const res = await fetch(url, {...init, headers});
  const text = await res.text();
  const body = text.length === 0 ? null : JSON.parse(text);
  return {status: res.status, body};
};

const findId = async (url: string, filePath: string): Promise<string> => {
  const r = await fetchAuthed(`${url}/sections?file_path=${encodeURIComponent(filePath)}`);
  return (r.body as {items: Array<{record_id: string}>}).items[0]!.record_id;
};

// Bodies deliberately end without a trailing newline so a query can be made
// byte-identical to a stored chunk (FakeEmbedder: same text ⇒ same vector).
const ALPHA_BODY = 'The quick brown fox guards the vault storage room.';

const seed = (root: string): void => {
  writeMd(
    root,
    'topics/alpha.md',
    ['---', 'title: Alpha', 'created: 2026-08-01', 'updated: 2026-08-01', '---', ALPHA_BODY].join(
      '\n'
    )
  );
  writeMd(
    root,
    'topics/beta.md',
    [
      '---',
      'title: Beta',
      'created: 2026-08-01',
      'updated: 2026-08-01',
      '---',
      'A completely different note about embeddings and chunking.'
    ].join('\n')
  );
  writeMd(
    root,
    'topics/gamma.md',
    [
      '---',
      'title: Gamma',
      'created: 2026-08-01',
      'updated: 2026-08-01',
      'agent:',
      '  summary: Gamma is the neighbor note.',
      '  derived_from_hash: irrelevant',
      '---',
      'Gamma neighbor note body.'
    ].join('\n')
  );
};

interface PackChunk {
  record_id: string;
  file_path: string;
  title: string | null;
  chunk_index: number;
  text: string;
  semantic_score?: number;
  lexical_score?: number;
  sources: string[];
}

interface Pack {
  anchor: Record<string, unknown>;
  chunks: PackChunk[];
  graph: {
    root: {record_id: string; file_path: string};
    neighborhood: Array<{
      record_id: string;
      summary: string | null;
      edges: Array<{type: string; direction: string}>;
    }>;
    neighborhood_total: number;
    backlinks: Array<{record_id: string; edge_type: string}>;
    backlinks_total: number;
  } | null;
  budget: {max_bytes: number; used_bytes: number; chunks_dropped: number};
}

test('POST /context-pack — query mode packs chunks, graph, and budget', async t => {
  const {root, cleanup} = setup();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const alphaId = await findId(ctx.url, 'topics/alpha.md');
      const gammaId = await findId(ctx.url, 'topics/gamma.md');
      // gamma cites alpha — alpha's inbound edge, hence backlink + neighbor.
      new EdgesRepository(ctx.db).upsert({
        fromId: gammaId,
        toId: alphaId,
        type: 'cites',
        weight: 1,
        note: null,
        created: '2026-08-01'
      });

      const r = await fetchAuthed(
        `${ctx.url}/context-pack?query=${encodeURIComponent(ALPHA_BODY)}`,
        {method: 'POST'}
      );
      t.equal(r.status, 200, '200 ok');
      const pack = r.body as Pack;

      t.deepEqual(pack.anchor, {query: ALPHA_BODY}, 'query echoed as the anchor');
      t.ok(pack.chunks.length >= 1, 'chunks present');
      const top = pack.chunks[0]!;
      t.equal(top.record_id, alphaId, 'byte-identical query ranks its record first');
      t.equal(top.text, ALPHA_BODY, 'chunk text is the bare body segment');
      t.equal(top.chunk_index, 0, 'single-chunk record wins at index 0');
      t.equal(top.semantic_score, 1, 'identical embedding scores 1');
      t.deepEqual(top.sources, ['semantic', 'lexical'], 'both retrieval legs saw the record');

      t.equal(pack.graph?.root.record_id, alphaId, 'graph rooted at the top fused record');
      t.equal(pack.graph?.neighborhood_total, 1, 'one 1-hop neighbor');
      t.equal(pack.graph?.neighborhood[0]?.record_id, gammaId, 'gamma is the neighbor');
      t.equal(
        pack.graph?.neighborhood[0]?.summary,
        'Gamma is the neighbor note.',
        'neighbor carries its agent.summary'
      );
      t.deepEqual(
        pack.graph?.neighborhood[0]?.edges,
        [{type: 'cites', direction: 'inbound'}],
        'typed edge with direction'
      );
      t.equal(pack.graph?.backlinks_total, 1, 'one backlink');
      t.equal(pack.graph?.backlinks[0]?.record_id, gammaId, 'gamma cites alpha');
      t.equal(pack.graph?.backlinks[0]?.edge_type, 'cites', 'backlink edge type surfaced');

      t.equal(pack.budget.max_bytes, 32 * 1024, 'default budget');
      t.equal(pack.budget.chunks_dropped, 0, 'small pack drops nothing');
      t.ok(pack.budget.used_bytes > 0 && pack.budget.used_bytes <= 32 * 1024, 'usage reported');

      const tight = await fetchAuthed(
        `${ctx.url}/context-pack?query=${encodeURIComponent(ALPHA_BODY)}&max_bytes=700`,
        {method: 'POST'}
      );
      const tightPack = tight.body as Pack;
      t.ok(tightPack.budget.chunks_dropped >= 1, 'tight budget drops lowest-ranked chunks');
      t.ok(
        tightPack.chunks.length < pack.chunks.length,
        'dropped chunks are gone from the response'
      );
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /context-pack — lexical-only records contribute their best segment', async t => {
  const {root, cleanup} = setup();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      // Written through the API after the embed pass: indexed in FTS but
      // carrying no vectors, so only the lexical leg can find it.
      const put = await fetchAuthed(`${ctx.url}/vault/topics/lex.md`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          frontmatter: {title: 'Xylophone lore'},
          body: 'The xylophone quartz marker lives here and nowhere else.'
        })
      });
      t.equal(put.status, 204, 'note written');

      const r = await fetchAuthed(`${ctx.url}/context-pack?query=xylophone%20quartz`, {
        method: 'POST'
      });
      t.equal(r.status, 200, '200 ok');
      const pack = r.body as Pack;
      const lex = pack.chunks.find(c => c.file_path === 'topics/lex.md');
      t.ok(lex, 'unembedded record still reachable through the lexical leg');
      t.deepEqual(lex?.sources, ['lexical'], 'marked lexical-only');
      t.ok(lex?.text.includes('xylophone quartz'), 'segment containing the terms selected');
      t.equal(lex?.semantic_score, undefined, 'no semantic score without vectors');
      t.ok((lex?.lexical_score ?? 0) > 0, 'lexical score surfaced');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /context-pack — record_id mode anchors on the record', async t => {
  const {root, cleanup} = setup();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const alphaId = await findId(ctx.url, 'topics/alpha.md');
      const r = await fetchAuthed(`${ctx.url}/context-pack?record_id=${alphaId}`, {
        method: 'POST'
      });
      t.equal(r.status, 200, '200 ok');
      const pack = r.body as Pack;
      t.equal(pack.anchor['record_id'], alphaId, 'anchor is the record');
      t.equal(pack.graph?.root.record_id, alphaId, 'graph rooted at the anchor');
      t.ok(pack.chunks.length >= 1, 'neighbors contribute chunks');
      t.notOk(
        pack.chunks.some(c => c.record_id === alphaId),
        'the anchor itself is not in its own pack'
      );
      for (const c of pack.chunks) {
        t.deepEqual(c.sources, ['semantic'], 'record mode is semantic-only');
      }
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});

test('POST /context-pack — validation', async t => {
  const {root, cleanup} = setup();
  try {
    seed(root);
    const ctx = await startTestServer(root);
    try {
      const neither = await fetchAuthed(`${ctx.url}/context-pack`, {method: 'POST'});
      t.equal(neither.status, 400, 'neither query nor record_id is a 400');
      const both = await fetchAuthed(`${ctx.url}/context-pack?query=x&record_id=y`, {
        method: 'POST'
      });
      t.equal(both.status, 400, 'both anchors is a 400');
      const unknown = await fetchAuthed(`${ctx.url}/context-pack?query=x&bogus=1`, {
        method: 'POST'
      });
      t.equal(unknown.status, 400, 'unknown query parameter is a 400');
      const badK = await fetchAuthed(`${ctx.url}/context-pack?query=x&k=0`, {method: 'POST'});
      t.equal(badK.status, 400, 'k=0 is a 400');
      const badBytes = await fetchAuthed(`${ctx.url}/context-pack?query=x&max_bytes=nope`, {
        method: 'POST'
      });
      t.equal(badBytes.status, 400, 'non-numeric max_bytes is a 400');
      const missing = await fetchAuthed(`${ctx.url}/context-pack?record_id=nope`, {
        method: 'POST'
      });
      t.equal(missing.status, 404, 'unknown record_id is a 404');
    } finally {
      await teardown(ctx);
    }
  } finally {
    cleanup();
  }
});
