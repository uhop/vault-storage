import {createHash} from 'node:crypto';
import type {Embedder} from './types.ts';

/**
 * Deterministic embedder for tests. The output is sha256(text) seeded into
 * an xorshift32 PRNG, mapped to [-1, 1], then L2-normalized to unit length.
 *
 * Properties exercised by tests:
 *   - same input ⇒ same vector
 *   - different inputs ⇒ different vectors (with overwhelming probability)
 *   - vectors lie on the unit sphere — cosine and dot product agree
 *   - the dim is configurable for resolver-shape tests; defaults to 384 to
 *     match the production embedding model.
 *
 * Not suitable for any retrieval-quality test — it preserves no semantics.
 */
export class FakeEmbedder implements Embedder {
  readonly dim: number;
  readonly modelName: string;

  constructor(opts: {dim?: number; modelName?: string} = {}) {
    this.dim = opts.dim ?? 384;
    this.modelName = opts.modelName ?? `fake-deterministic-${this.dim}`;
  }

  async embed(text: string): Promise<Float32Array> {
    return this.#embedSync(text);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map(t => this.#embedSync(t));
  }

  #embedSync(text: string): Float32Array {
    const seed = createHash('sha256').update(text, 'utf8').digest();
    const vec = new Float32Array(this.dim);

    let state = seed.readUInt32BE(0);
    if (state === 0) state = 1; // xorshift requires non-zero state

    for (let i = 0; i < this.dim; i++) {
      state ^= state << 13;
      state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      vec[i] = (state / 0xffffffff) * 2 - 1;
    }

    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dim; i++) vec[i] = vec[i]! / norm;
    }
    return vec;
  }
}
