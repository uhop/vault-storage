import {pipeline} from '@huggingface/transformers';
import type {FeatureExtractionPipeline} from '@huggingface/transformers';
import {retryNonFiniteVectors, type AnomalyLogger} from './anomaly-log.ts';
import type {Embedder} from './types.ts';

const DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5';
const DEFAULT_DIM = 384;

// BGE has a 512-token context. We truncate at character level rather than
// running a separate tokenizer pass — the tokenizer is invoked inside the
// pipeline anyway, and a generous char cap is cheap and predictable. 1500
// chars is ~400 tokens for English prose, ~500 tokens for code-heavy /
// punctuation-dense content; both stay safely inside 512.
//
// Rationale: BGE-base under transformers.js produces *degenerate* embeddings
// on inputs that overflow 512 tokens (verified 2026-04-28 — unrelated long
// docs cosine to 0.89, related ones to 0.85; pre-truncating to 1500 chars
// restores the correct ordering at 0.75/0.60). BGE-small degrades more
// gracefully on long inputs but still benefits from a known truncation point.
const DEFAULT_MAX_CHARS = 1500;

/**
 * Real embedder backed by transformers.js (`@huggingface/transformers`) running
 * a BGE ONNX model on CPU. CLS-token pooled, L2-normalized — sqlite-vec
 * dot-product agrees with cosine similarity on the unit sphere.
 *
 * Pooling note: the BGE family officially recommends `[CLS]` pooling. Mean
 * pooling happens to work tolerably for BGE-small but produces severely
 * anisotropic embeddings on BGE-base (everything ~0.9 cosine to everything;
 * topic-irrelevant neighbours), which destroys retrieval quality. The eval
 * harness's first run vs. BGE-base under mean-pool was the symptom; switching
 * to CLS-pool restored it.
 *
 * The pipeline is loaded lazily on the first call and reused; load + first
 * inference downloads the model (~33 MB for small, ~110 MB for base) into the
 * transformers.js cache.
 *
 * **NaN-on-output**: transformers.js+BGE emits a non-finite chunk vector on
 * rare inputs (~0.035% empirically — caught 2026-05-03; same workaround
 * shape as `aviatesk/obsidian-sonar` PR #8). Root cause undetermined and
 * non-deterministic — re-embedding the same text usually returns clean
 * output. `embedBatch` detects this, retries each affected chunk individually,
 * and persists every event (with full chunk text + sha256 + batch context)
 * via the optional `anomalyLogger` so failures can be reproduced offline.
 */
export class BgeEmbedder implements Embedder {
  readonly dim: number;
  readonly modelName: string;
  readonly pooling: 'cls' | 'mean';
  readonly maxChars: number;
  readonly anomalyLogger: AnomalyLogger | null;
  #pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(
    opts: {
      modelName?: string;
      dim?: number;
      pooling?: 'cls' | 'mean';
      maxChars?: number;
      anomalyLogger?: AnomalyLogger | null;
    } = {}
  ) {
    this.modelName = opts.modelName ?? DEFAULT_MODEL;
    this.dim = opts.dim ?? DEFAULT_DIM;
    this.pooling = opts.pooling ?? 'cls';
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    this.anomalyLogger = opts.anomalyLogger ?? null;
  }

  #cap(text: string): string {
    return text.length > this.maxChars ? text.slice(0, this.maxChars) : text;
  }

  async embed(text: string): Promise<Float32Array> {
    const pipe = await this.#getPipeline();
    const out = await pipe(this.#cap(text), {pooling: this.pooling, normalize: true});
    return (out.data as Float32Array).slice();
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const pipe = await this.#getPipeline();
    const out = await pipe(
      texts.map(t => this.#cap(t)),
      {
        pooling: this.pooling,
        normalize: true
      }
    );
    const flat = out.data as Float32Array;
    const result: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      result.push(flat.slice(i * this.dim, (i + 1) * this.dim));
    }

    // Detect non-finite vectors and retry singly. Empirically the NaN is
    // transient and isolated — retrying just the affected chunk on its own
    // (different batch shape, fresh ONNX call) almost always returns clean
    // output. Same workaround shape as aviatesk/obsidian-sonar PR #8.
    return retryNonFiniteVectors(
      texts,
      result,
      t => this.embed(t),
      {modelName: this.modelName, pooling: this.pooling},
      this.anomalyLogger
    );
  }

  #getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.#pipelinePromise) {
      this.#pipelinePromise = pipeline('feature-extraction', this.modelName);
    }
    return this.#pipelinePromise;
  }
}
