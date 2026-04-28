import test from 'tape-six';
import {BgeEmbedder} from '../src/embeddings/bge.ts';

// Slow on first run: downloads ~33 MB of model files into the transformers.js
// cache. Subsequent runs hit the cache and complete in under two seconds.
test('BgeEmbedder (real model)', async t => {
  const embedder = new BgeEmbedder();

  await t.test('reports the locked model name and dim', t => {
    t.equal(embedder.modelName, 'Xenova/bge-small-en-v1.5', 'default model name');
    t.equal(embedder.dim, 384, 'dim 384');
  });

  await t.test('produces a 384-dim float32 vector', async t => {
    const v = await embedder.embed('hello vault');
    t.ok(v instanceof Float32Array, 'Float32Array');
    t.equal(v.length, 384, 'dim is 384');
  });

  await t.test('vectors are L2-normalized to unit length', async t => {
    const v = await embedder.embed('the quick brown fox');
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    t.ok(Math.abs(norm - 1) < 1e-4, `unit norm within tolerance (got ${norm})`);
  });

  await t.test('semantically similar texts are closer than dissimilar ones', async t => {
    const a = await embedder.embed('cats and dogs are common pets');
    const b = await embedder.embed('many households keep dogs and cats');
    const c = await embedder.embed('quantum chromodynamics describes the strong force');

    const dot = (x: Float32Array, y: Float32Array): number => {
      let s = 0;
      for (let i = 0; i < x.length; i++) s += x[i]! * y[i]!;
      return s;
    };

    const ab = dot(a, b);
    const ac = dot(a, c);
    t.ok(ab > ac, `pet sentences closer than pets-vs-physics (ab=${ab.toFixed(3)}, ac=${ac.toFixed(3)})`);
  });

  await t.test('embedBatch returns one vector per input in order', async t => {
    const out = await embedder.embedBatch(['alpha', 'beta', 'gamma']);
    t.equal(out.length, 3, 'three vectors');
    t.equal(out[0]!.length, 384, 'first vector dim 384');

    const single = await embedder.embed('beta');
    let cos = 0;
    for (let i = 0; i < 384; i++) cos += out[1]![i]! * single[i]!;
    t.ok(Math.abs(cos - 1) < 1e-4, 'single embed of "beta" matches batched (cos≈1)');
  });

  await t.test('embedBatch on empty input returns empty array', async t => {
    const out = await embedder.embedBatch([]);
    t.equal(out.length, 0, 'empty in, empty out');
  });
});
