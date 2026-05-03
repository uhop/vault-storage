import test from 'tape-six';
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  buildAnomalyEntry,
  JsonlAnomalyLogger,
  retryNonFiniteVectors,
  type AnomalyEntry,
  type AnomalyLogger
} from '../src/embeddings/anomaly-log.ts';

test('buildAnomalyEntry: stable sha256 + length, optional error', t => {
  const e1 = buildAnomalyEntry({
    stage: 'detected',
    modelName: 'Xenova/bge-small-en-v1.5',
    pooling: 'cls',
    batchSize: 32,
    batchIndex: 7,
    chunk: 'hello world',
    now: '2026-05-03T17:00:00.000Z'
  });
  t.equal(e1.stage, 'detected');
  t.equal(e1.chunkLength, 11);
  t.equal(
    e1.chunkSha256,
    'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    'sha256 of "hello world"'
  );
  t.equal(e1.error, undefined, 'no error key when none supplied');

  const e2 = buildAnomalyEntry({
    stage: 'retry-threw',
    modelName: 'm',
    pooling: 'cls',
    batchSize: 1,
    batchIndex: 0,
    chunk: 'x',
    error: 'boom',
    now: '2026-05-03T17:00:00.000Z'
  });
  t.equal(e2.error, 'boom');
});

test('JsonlAnomalyLogger: appends valid JSON-per-line, creates parent dir', async t => {
  const root = mkdtempSync(join(tmpdir(), 'anomaly-log-'));
  try {
    const path = join(root, 'sub', 'deeper', 'embed-nan.jsonl');
    const logger = new JsonlAnomalyLogger(path);
    const entry: AnomalyEntry = buildAnomalyEntry({
      stage: 'detected',
      modelName: 'm',
      pooling: 'cls',
      batchSize: 1,
      batchIndex: 0,
      chunk: 'first',
      now: '2026-05-03T17:00:00.000Z'
    });
    await logger.log(entry);
    t.ok(existsSync(path), 'file created');
    const after1 = readFileSync(path, 'utf8');
    t.equal(after1.split('\n').filter(Boolean).length, 1, 'exactly one line');
    const parsed = JSON.parse(after1.trim()) as AnomalyEntry;
    t.equal(parsed.stage, 'detected');
    t.equal(parsed.chunk, 'first');
    t.equal(parsed.chunkSha256.length, 64);

    // Append another entry — file should now have two lines.
    await logger.log(
      buildAnomalyEntry({
        stage: 'retry-succeeded',
        modelName: 'm',
        pooling: 'cls',
        batchSize: 1,
        batchIndex: 0,
        chunk: 'first',
        now: '2026-05-03T17:00:01.000Z'
      })
    );
    const after2 = readFileSync(path, 'utf8');
    const lines = after2.split('\n').filter(Boolean);
    t.equal(lines.length, 2, 'two lines after second append');
    const second = JSON.parse(lines[1]!) as AnomalyEntry;
    t.equal(second.stage, 'retry-succeeded');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

class CapturingLogger implements AnomalyLogger {
  readonly entries: AnomalyEntry[] = [];
  async log(entry: AnomalyEntry): Promise<void> {
    this.entries.push(entry);
  }
}

test('retryNonFiniteVectors: leaves finite vectors untouched', async t => {
  const texts = ['a', 'b'];
  const vectors = [new Float32Array([1, 0]), new Float32Array([0, 1])];
  let calls = 0;
  const logger = new CapturingLogger();
  const out = await retryNonFiniteVectors(
    texts,
    vectors,
    async _ => {
      ++calls;
      return new Float32Array([0, 0]);
    },
    {modelName: 'm', pooling: 'cls'},
    logger
  );
  t.equal(calls, 0, 'embedSingle never called when all vectors are clean');
  t.equal(logger.entries.length, 0, 'no anomaly entries logged');
  t.equal(out[0], vectors[0], 'returns the same arrays');
});

test('retryNonFiniteVectors: retry succeeds — patches vector, logs detected+success', async t => {
  const texts = ['clean', 'transient-bad', 'clean'];
  const vectors = [
    new Float32Array([1, 0]),
    new Float32Array([NaN, NaN]), // bad
    new Float32Array([0, 1])
  ];
  const logger = new CapturingLogger();
  const out = await retryNonFiniteVectors(
    texts,
    vectors,
    async _ => {
      // The retry call returns clean output for the same text.
      return new Float32Array([0.5, 0.5]);
    },
    {modelName: 'Xenova/bge-small-en-v1.5', pooling: 'cls'},
    logger
  );
  t.equal(out[1]![0], 0.5, 'patched with retry result');
  t.equal(out[1]![1], 0.5);
  t.equal(logger.entries.length, 2, 'two log entries — detected + retry-succeeded');
  t.equal(logger.entries[0]!.stage, 'detected');
  t.equal(logger.entries[0]!.batchIndex, 1, 'batchIndex is the bad slot');
  t.equal(logger.entries[0]!.batchSize, 3);
  t.equal(logger.entries[0]!.chunk, 'transient-bad', 'full chunk text captured');
  t.equal(logger.entries[1]!.stage, 'retry-succeeded');
});

test('retryNonFiniteVectors: retry still NaN — leaves original, logs both events', async t => {
  const texts = ['persistent-bad'];
  const vectors = [new Float32Array([NaN, NaN, NaN])];
  const logger = new CapturingLogger();
  const out = await retryNonFiniteVectors(
    texts,
    vectors,
    async _ => new Float32Array([NaN, NaN, NaN]), // retry also bad
    {modelName: 'm', pooling: 'cls'},
    logger
  );
  t.ok(Number.isNaN(out[0]![0]), 'still NaN — left alone for downstream filter');
  t.equal(logger.entries.length, 2);
  t.equal(logger.entries[1]!.stage, 'retry-still-nan');
});

test('retryNonFiniteVectors: retry throws — leaves original, logs throw with message', async t => {
  const texts = ['boom-input'];
  const vectors = [new Float32Array([NaN, NaN])];
  const logger = new CapturingLogger();
  await retryNonFiniteVectors(
    texts,
    vectors,
    async _ => {
      throw new Error('ONNX exploded');
    },
    {modelName: 'm', pooling: 'cls'},
    logger
  );
  t.equal(logger.entries.length, 2);
  t.equal(logger.entries[1]!.stage, 'retry-threw');
  t.equal(logger.entries[1]!.error, 'ONNX exploded', 'error message preserved');
});

test('retryNonFiniteVectors: works with logger=null (stderr-only path)', async t => {
  const texts = ['x'];
  const vectors = [new Float32Array([NaN])];
  let threw = false;
  try {
    await retryNonFiniteVectors(
      texts,
      vectors,
      async _ => new Float32Array([1]),
      {modelName: 'm', pooling: 'cls'},
      null
    );
  } catch {
    threw = true;
  }
  t.notOk(threw, 'no logger is fine — events still go to stderr');
  t.equal(vectors[0]![0], 1, 'retry result still applied');
});

test('JsonlAnomalyLogger: log() never throws on filesystem failure', async t => {
  // Pointing at a path under a non-writable parent that can't be created
  // (a regular file, not a directory). mkdir -p on the parent fails; the
  // logger should swallow and continue.
  const root = mkdtempSync(join(tmpdir(), 'anomaly-log-fail-'));
  try {
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'this is a file, not a directory');
    const path = join(blocker, 'log.jsonl'); // mkdir(blocker, recursive) fails
    const logger = new JsonlAnomalyLogger(path);
    let threw = false;
    try {
      await logger.log(
        buildAnomalyEntry({
          stage: 'detected',
          modelName: 'm',
          pooling: 'cls',
          batchSize: 1,
          batchIndex: 0,
          chunk: 'x',
          now: '2026-05-03T17:00:00.000Z'
        })
      );
    } catch {
      threw = true;
    }
    t.notOk(threw, 'log() must swallow filesystem errors so the embedder stays alive');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
