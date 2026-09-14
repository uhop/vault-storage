import test from 'tape-six';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChildProcessEmbedder} from '../src/embeddings/child-embedder.ts';
import {FakeEmbedder} from '../src/embeddings/fake.ts';

test('ChildProcessEmbedder returns what the embedder inside it returns', async t => {
  const embedder = new ChildProcessEmbedder({kind: 'fake'});
  const local = new FakeEmbedder();
  try {
    t.equal(embedder.dim, local.dim, 'same dimension');
    t.equal(embedder.modelName, local.modelName, 'same model name');
    const texts = ['alpha', 'beta', 'gamma'];
    const vectors = await embedder.embedBatch(texts);
    const expected = await local.embedBatch(texts);
    t.ok(vectors[0] instanceof Float32Array, 'vectors arrive as Float32Array');
    t.deepEqual(
      vectors.map(v => Array.from(v)),
      expected.map(v => Array.from(v)),
      'vectors match the in-process embedder'
    );
    t.deepEqual(
      Array.from(await embedder.embed('alpha')),
      Array.from(expected[0]!),
      'embed matches'
    );
    t.deepEqual(await embedder.embedBatch([]), [], 'an empty batch never reaches the child');
  } finally {
    await embedder.terminate();
  }
});

test('ChildProcessEmbedder resolves concurrent calls to their own results', async t => {
  const embedder = new ChildProcessEmbedder({kind: 'fake'});
  const local = new FakeEmbedder();
  try {
    const texts = Array.from({length: 20}, (_, i) => `text ${i}`);
    const results = await Promise.all(texts.map(text => embedder.embed(text)));
    for (let i = 0; i < texts.length; ++i) {
      t.deepEqual(Array.from(results[i]!), Array.from(await local.embed(texts[i]!)), texts[i]);
    }
  } finally {
    await embedder.terminate();
  }
});

test('ChildProcessEmbedder keeps the event loop free while the model blocks', async t => {
  const embedder = new ChildProcessEmbedder({kind: 'fake', blockMs: 400});
  try {
    await embedder.embed('start the child');
    let maxLate = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      maxLate = Math.max(maxLate, now - last - 10);
      last = now;
    }, 10);
    const start = performance.now();
    await embedder.embedBatch(['one', 'two']);
    const elapsed = performance.now() - start;
    clearInterval(timer);
    t.ok(elapsed >= 400, `the call waited for the blocked child (${Math.round(elapsed)} ms)`);
    t.ok(maxLate < 150, `the parent kept ticking (longest delay ${Math.round(maxLate)} ms)`);
  } finally {
    await embedder.terminate();
  }
});

test('ChildProcessEmbedder rejects pending calls when the child stops, then starts a new one', async t => {
  const embedder = new ChildProcessEmbedder({kind: 'fake', blockMs: 300});
  const rejected = t.rejects(embedder.embed('interrupted'), Error, 'the pending call rejects');
  await embedder.terminate();
  await rejected;
  try {
    const vector = await embedder.embed('after restart');
    t.equal(vector.length, embedder.dim, 'the next call starts a fresh child');
  } finally {
    await embedder.terminate();
  }
});

test('ChildProcessEmbedder (real model) embeds, restarts, and tracks retained', async t => {
  const embedder = new ChildProcessEmbedder({kind: 'bge'});
  try {
    t.equal(embedder.retained, false, 'nothing loaded before the first call');
    const [a, b] = await embedder.embedBatch([
      'the cat sat on the mat',
      'a feline rested on a rug'
    ]);
    t.equal(a!.length, 384, '384 dimensions');
    let norm = 0;
    for (const x of a!) norm += x * x;
    t.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-3, 'unit length');
    let dot = 0;
    for (let i = 0; i < 384; ++i) dot += a![i]! * b![i]!;
    t.ok(dot > 0.5, `paraphrases are close (${dot.toFixed(3)})`);
    t.equal(embedder.retained, true, 'the model is loaded after a call');
    await embedder.releaseRetained();
    t.equal(embedder.retained, false, 'released');

    await embedder.terminate();
    const [again] = await embedder.embedBatch(['the cat sat on the mat']);
    t.deepEqual(Array.from(again!), Array.from(a!), 'a restarted child loads the model again');
  } finally {
    await embedder.terminate();
  }
});

test('ChildProcessEmbedder lets a plain script exit, with or without terminate', async t => {
  const moduleUrl = new URL('../src/embeddings/child-embedder.ts', import.meta.url).href;
  const dir = mkdtempSync(join(tmpdir(), 'child-embedder-exit-'));
  try {
    for (const [label, tail] of [
      ['with terminate', 'await embedder.terminate();'],
      ['without terminate', '']
    ] as const) {
      const file = join(dir, `${label.replaceAll(' ', '-')}.mjs`);
      writeFileSync(
        file,
        `import {ChildProcessEmbedder} from ${JSON.stringify(moduleUrl)};\n` +
          `const embedder = new ChildProcessEmbedder({kind: 'fake'});\n` +
          `await embedder.embed('x');\nawait embedder.releaseRetained();\n${tail}\nconsole.log('done');\n`
      );
      const run = spawnSync(process.execPath, [file], {encoding: 'utf8', timeout: 30_000});
      t.equal(run.status, 0, `${label}: exit code 0 (stderr: ${run.stderr.trim().slice(0, 300)})`);
      t.equal(run.stdout.trim(), 'done', `${label}: the script finished`);
    }
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
