import test from 'tape-six';
import {FakeEmbedder} from '../src/embeddings/fake.ts';

test('FakeEmbedder', async t => {
  const embedder = new FakeEmbedder();

  await t.test('produces a 384-dim float32 vector by default', async t => {
    const v = await embedder.embed('hello');
    t.equal(v.length, 384, 'dim is 384');
    t.ok(v instanceof Float32Array, 'Float32Array');
  });

  await t.test('is deterministic on the same input', async t => {
    const a = await embedder.embed('the quick brown fox');
    const b = await embedder.embed('the quick brown fox');
    t.deepEqual(Array.from(a), Array.from(b), 'identical bytes');
  });

  await t.test('produces distinct vectors for distinct inputs', async t => {
    const a = await embedder.embed('alpha');
    const b = await embedder.embed('beta');
    let same = 0;
    for (let i = 0; i < 384; i++) if (a[i] === b[i]) same++;
    t.ok(same < 384, 'vectors differ at most positions');
  });

  await t.test('vectors are L2-normalized to unit length', async t => {
    const v = await embedder.embed('whatever');
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    t.ok(Math.abs(norm - 1) < 1e-6, 'unit norm within float tolerance');
  });

  await t.test('embedBatch returns one vector per input in order', async t => {
    const out = await embedder.embedBatch(['a', 'b', 'c']);
    t.equal(out.length, 3, 'three vectors');
    const single = await embedder.embed('b');
    t.deepEqual(Array.from(out[1]!), Array.from(single), 'middle vector matches single embed');
  });

  await t.test('honors custom dim', async t => {
    const e = new FakeEmbedder({dim: 64});
    const v = await e.embed('x');
    t.equal(v.length, 64, 'dim 64');
    t.equal(e.dim, 64, 'reports custom dim');
  });

  await t.test('exposes a modelName', t => {
    t.equal(embedder.modelName, 'fake-deterministic-384', 'default model name');
    t.equal(new FakeEmbedder({modelName: 'custom'}).modelName, 'custom', 'override');
  });
});
