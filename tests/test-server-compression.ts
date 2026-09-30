import {randomBytes} from 'node:crypto';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {request} from 'node:http';
import type {IncomingHttpHeaders, ServerResponse} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {brotliDecompressSync, gunzipSync, zstdDecompressSync} from 'node:zlib';
import test from 'tape-six';
import {openDatabase} from '../src/db/connection.ts';
import {runMigrations} from '../src/db/migrate.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';
import {coder, negotiateEncoding, sendBuffer} from '../src/server/compress.ts';
import type {ServerEnv} from '../src/server/env.ts';
import {sendJson} from '../src/server/responses.ts';
import {startServer} from '../src/server/server.ts';

const TEST_TOKEN = 'test-token-compression';

/** Markdown-shaped and highly compressible, well past the 1400-byte floor. */
const BIG =
  '# Heading\n\nA paragraph of prose that repeats itself often enough to code well.\n\n'.repeat(
    400
  );
const SMALL = 'tiny';

const makeEnv = (uiStaticPath: string): ServerEnv => ({
  vaultDataPath: '/tmp/vault-storage-test-data',
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
  commitIntervalMs: 60000,
  commitIntervalMaxMs: 0,
  workHoursStart: null,
  workHoursEnd: null,
  gitAuthorName: 'vault-storage',
  gitAuthorEmail: 'vault-storage@localhost',
  uiStaticPath,
  embedAnomalyLogPath: '',
  memoryReportIntervalMs: 0
});

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * `node:http` rather than `fetch`: undici sets its own `Accept-Encoding` and
 * decodes the answer, so neither the request header nor the coded bytes
 * would be the ones under test.
 */
const raw = (url: string, headers: Record<string, string> = {}): Promise<RawResponse> =>
  new Promise((resolve, reject) => {
    const req = request(url, {headers}, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks)})
      );
    });
    req.on('error', reject);
    req.end();
  });

const withServer = async (fn: (url: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), 'vault-compression-'));
  writeFileSync(join(dir, 'big.js'), BIG);
  writeFileSync(join(dir, 'small.js'), SMALL);
  // A PNG header is enough: the handler keys off the extension, not the bytes.
  writeFileSync(
    join(dir, 'pic.png'),
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(BIG)])
  );
  const data = join(dir, 'data');
  mkdirSync(join(data, 'notes'), {recursive: true});
  writeFileSync(join(data, 'notes', 'big.md'), `---\ntitle: Big\n---\n\n${BIG}`);
  const db = openDatabase({path: ':memory:'});
  const migration = runMigrations(db);
  const handle = await startServer({
    db,
    env: {...makeEnv(dir), vaultDataPath: data},
    schemaVersion: migration.current,
    embedder: new FakeEmbedder()
  });
  const addr = handle.server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await handle.close();
    db.close();
    rmSync(dir, {recursive: true, force: true});
  }
};

test('negotiateEncoding picks by weight, then by our preference', t => {
  t.equal(negotiateEncoding(undefined), null, 'absent header is identity');
  t.equal(negotiateEncoding(''), null, 'empty header is identity');
  t.equal(negotiateEncoding('identity'), null, 'identity only');
  t.equal(negotiateEncoding('gzip, deflate, br, zstd'), 'zstd', 'equal weights take our order');
  t.equal(negotiateEncoding('gzip, deflate, br'), 'br', 'brotli over gzip');
  t.equal(negotiateEncoding('gzip, deflate'), 'gzip', 'gzip when it is all there is');
  t.equal(negotiateEncoding('gzip;q=1.0, br;q=0.5'), 'gzip', 'a higher weight wins');
  t.equal(negotiateEncoding('zstd;q=0, br'), 'br', 'q=0 is a refusal');
  t.equal(negotiateEncoding('deflate'), null, 'an unsupported coding alone is identity');
  t.equal(negotiateEncoding('*'), 'zstd', 'wildcard takes our first preference');
  t.equal(negotiateEncoding('*;q=0.1, gzip;q=0.9'), 'gzip', 'a named weight beats the wildcard');
  t.equal(negotiateEncoding('br;q=bogus'), null, 'an unparseable weight is a refusal');
  t.equal(
    negotiateEncoding('zstd;q=0, *'),
    'br',
    'a named refusal is not overridden by the wildcard'
  );
  t.equal(negotiateEncoding('gzip;Q=0'), null, 'the weight name is case-insensitive');
  t.equal(negotiateEncoding(', gzip'), 'gzip', 'an empty list member is skipped');
});

test('a compressible body is coded per Accept-Encoding and round-trips', async t => {
  await withServer(async url => {
    const cases: [string, string, (b: Buffer) => Buffer][] = [
      ['zstd, br, gzip', 'zstd', zstdDecompressSync],
      ['br, gzip', 'br', brotliDecompressSync],
      ['gzip', 'gzip', gunzipSync]
    ];
    for (const [accept, expected, decode] of cases) {
      const res = await raw(`${url}/ui/big.js`, {'Accept-Encoding': accept});
      t.equal(res.status, 200, `200 for ${expected}`);
      t.equal(res.headers['content-encoding'], expected, `coded ${expected}`);
      t.equal(res.headers['vary'], 'Accept-Encoding', 'Vary announces the negotiation');
      t.ok(res.body.byteLength < Buffer.byteLength(BIG), `${expected} is smaller than the source`);
      t.equal(
        res.headers['content-length'],
        res.body.byteLength.toString(),
        'Content-Length counts the coded bytes'
      );
      t.equal(decode(res.body).toString('utf8'), BIG, `${expected} decodes to the source`);
    }
  });
});

test('identity is served when the client asks for nothing, and Vary still rides', async t => {
  await withServer(async url => {
    const cases: Record<string, string>[] = [
      {},
      {'Accept-Encoding': 'identity'},
      {'Accept-Encoding': 'deflate'}
    ];
    for (const headers of cases) {
      const res = await raw(`${url}/ui/big.js`, headers);
      t.equal(res.headers['content-encoding'], undefined, 'no coding applied');
      t.equal(res.headers['vary'], 'Accept-Encoding', 'Vary rides on the uncoded answer too');
      t.equal(res.body.toString('utf8'), BIG, 'body is the source');
    }
  });
});

test('a body under the floor and an already-compressed type are left alone', async t => {
  await withServer(async url => {
    const small = await raw(`${url}/ui/small.js`, {'Accept-Encoding': 'zstd, br, gzip'});
    t.equal(small.headers['content-encoding'], undefined, 'under the floor, uncoded');
    t.equal(small.body.toString('utf8'), SMALL, 'body intact');

    const png = await raw(`${url}/ui/pic.png`, {'Accept-Encoding': 'zstd, br, gzip'});
    t.equal(png.headers['content-encoding'], undefined, 'png is not re-coded');
    t.equal(png.headers['vary'], undefined, 'and carries no Vary');
  });
});

/** Captures what a handler wrote, and resolves once the response is finished. */
const stubRes = (accept?: string) => {
  let done = (): void => {};
  const finished = new Promise<void>(resolve => (done = resolve));
  const chunks: Buffer[] = [];
  const res = {
    req: {headers: accept === undefined ? {} : {'accept-encoding': accept}},
    writableEnded: false,
    destroyed: false,
    status: 0,
    head: {} as Record<string, string>,
    writeHead(status: number, headers: Record<string, string>) {
      res.status = status;
      res.head = headers;
      return res;
    },
    end(body: Buffer) {
      chunks.push(body);
      res.writableEnded = true;
      done();
    }
  };
  return {res, finished, body: () => Buffer.concat(chunks)};
};

const asResponse = (res: unknown): ServerResponse => res as ServerResponse;

test('sendJson codes a payload past the floor and leaves a small one alone', async t => {
  const big = {
    items: Array.from({length: 400}, (_, i) => ({id: i, note: 'a repeated row that codes well'}))
  };
  const coded = stubRes('gzip');
  sendJson(asResponse(coded.res), 200, big);
  await coded.finished;
  t.equal(coded.res.status, 200, '200 OK');
  t.equal(coded.res.head['Content-Encoding'], 'gzip', 'coded');
  t.equal(coded.res.head['Vary'], 'Accept-Encoding', 'Vary set');
  t.equal(
    coded.res.head['Content-Length'],
    coded.body().byteLength.toString(),
    'Content-Length counts the coded bytes'
  );
  t.deepEqual(JSON.parse(gunzipSync(coded.body()).toString('utf8')), big, 'decodes to the payload');

  const plain = stubRes('gzip');
  sendJson(asResponse(plain.res), 200, {ok: true});
  await plain.finished;
  t.equal(plain.res.head['Content-Encoding'], undefined, 'a small payload is uncoded');
  t.deepEqual(JSON.parse(plain.body().toString('utf8')), {ok: true}, 'and is plain JSON');

  const identity = stubRes();
  sendJson(asResponse(identity.res), 200, big);
  await identity.finished;
  t.equal(identity.res.head['Content-Encoding'], undefined, 'no Accept-Encoding, no coding');
  t.deepEqual(JSON.parse(identity.body().toString('utf8')), big, 'and the payload is intact');
});

test('bodies are coded on the worker thread, and one that does not shrink goes out as it is', async t => {
  const headers = {'Content-Type': 'text/markdown; charset=utf-8'};
  const coded = stubRes('zstd');
  sendBuffer(asResponse(coded.res), 200, Buffer.from(BIG), headers);
  t.notOk(coded.res.writableEnded, 'written when the worker answers, not before');
  await coded.finished;
  t.equal(typeof coder.threadId, 'number', 'a worker thread runs');
  t.equal(coded.res.head['Content-Encoding'], 'zstd', 'coded');
  t.ok(zstdDecompressSync(coded.body()).equals(Buffer.from(BIG)), 'decodes to the body');

  const noise = randomBytes(4096);
  const plain = stubRes('gzip');
  sendBuffer(asResponse(plain.res), 200, noise, headers);
  await plain.finished;
  t.equal(plain.res.head['Content-Encoding'], undefined, 'no coding that does not pay');
  t.ok(plain.body().equals(noise), 'the body as it is');
});

test('a revalidated static file stays a 304 with no coding', async t => {
  await withServer(async url => {
    const first = await raw(`${url}/ui/big.js`, {'Accept-Encoding': 'gzip'});
    const etag = first.headers['etag'];
    t.ok(typeof etag === 'string' && etag.length > 0, 'ETag present on the coded answer');
    const second = await raw(`${url}/ui/big.js`, {
      'Accept-Encoding': 'gzip',
      'If-None-Match': etag as string
    });
    t.equal(second.status, 304, 'revalidates to 304');
    t.equal(second.body.byteLength, 0, 'no body on a 304');
    t.equal(second.headers['content-encoding'], undefined, 'and no coding on a 304');
    t.equal(second.headers['vary'], 'Accept-Encoding', 'Vary matches what a 200 would carry');
  });
});

test('each coding of a static file carries its own strong tag and revalidates to it', async t => {
  await withServer(async url => {
    const tags = new Set<string>();
    for (const coding of ['identity', 'gzip', 'br', 'zstd']) {
      const first = await raw(`${url}/ui/big.js`, {'Accept-Encoding': coding});
      const etag = first.headers['etag'] as string;
      const coded = coding === 'identity' ? undefined : coding;
      t.equal(first.headers['content-encoding'], coded, `${coding}: served as asked`);
      t.ok(
        coded === undefined ? !/-(?:zstd|br|gzip)"$/.test(etag) : etag.endsWith(`-${coding}"`),
        `${coding}: ${etag}`
      );
      tags.add(etag);
      const again = await raw(`${url}/ui/big.js`, {
        'Accept-Encoding': coding,
        'If-None-Match': etag
      });
      t.equal(again.status, 304, `${coding}: revalidates`);
      t.equal(again.headers['etag'], etag, `${coding}: the 304 names the tag the client holds`);
    }
    t.equal(tags.size, 4, 'four codings, four tags');
  });
});

test('the tag of a compressed read is accepted back as If-Match', async t => {
  await withServer(async url => {
    const auth = {Authorization: `Bearer ${TEST_TOKEN}`};
    const read = await raw(`${url}/vault/notes/big.md`, {...auth, 'Accept-Encoding': 'gzip'});
    t.equal(read.headers['content-encoding'], 'gzip');
    const etag = read.headers['etag'] as string;
    t.ok(etag.endsWith('-gzip"'), `coded tag ${etag}`);
    const text = gunzipSync(read.body).toString('utf8');
    const put = await fetch(`${url}/vault/notes/big.md`, {
      method: 'PUT',
      headers: {...auth, 'Content-Type': 'text/markdown', 'If-Match': etag},
      body: text.replace('# Heading', '# Changed')
    });
    t.equal(put.status, 204, 'the write lands');
    const stale = await fetch(`${url}/vault/notes/big.md`, {
      method: 'PUT',
      headers: {...auth, 'Content-Type': 'text/markdown', 'If-Match': etag},
      body: text
    });
    t.equal(stale.status, 412, 'and the same tag is stale after it');
    const body = (await stale.json()) as {details?: {current_etag?: string}};
    t.equal(`"${body.details?.current_etag}"`, put.headers.get('etag'), '412 names the bare tag');
  });
});
