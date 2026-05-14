import {pipeline} from '@huggingface/transformers';
import type {FeatureExtractionPipeline} from '@huggingface/transformers';
import {Retainer} from 'time-queues/Retainer.js';
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

// Default retention: 30 minutes of no embed/embedBatch calls before the ORT
// session is disposed. Empirically the inference arena occupies ~6 GB at our
// corpus scale (see `projects/vault-storage/queue` § "Investigate 7 GB
// anonymous heap"); releasing on idle returns the bulk of that to the OS.
// Reload on first post-idle embed adds ~1-3 s; first batch after reload
// reallocates the arena to that batch's shape.
const DEFAULT_RETENTION_MS = 30 * 60 * 1000;

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
 * The pipeline is held by a `time-queues` `Retainer` keyed off active
 * embed calls — `embed()`/`embedBatch()` bump a refcount on entry and drop
 * it on exit. After the last release the pipeline stays loaded for
 * `retentionMs`; if no new call arrives in that window the ONNX sessions
 * are disposed and the ~6 GB inference arena is returned to the OS. A new
 * call after release transparently reloads the model.
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
  readonly retentionMs: number;
  #retainer: Retainer<FeatureExtractionPipeline>;

  constructor(
    opts: {
      modelName?: string;
      dim?: number;
      pooling?: 'cls' | 'mean';
      maxChars?: number;
      anomalyLogger?: AnomalyLogger | null;
      retentionMs?: number;
    } = {}
  ) {
    this.modelName = opts.modelName ?? DEFAULT_MODEL;
    this.dim = opts.dim ?? DEFAULT_DIM;
    this.pooling = opts.pooling ?? 'cls';
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    this.anomalyLogger = opts.anomalyLogger ?? null;
    this.retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
    this.#retainer = new Retainer<FeatureExtractionPipeline>({
      create: () => pipeline('feature-extraction', this.modelName),
      destroy: pipe => pipe.dispose(),
      retentionPeriod: this.retentionMs
    });
  }

  get retained(): boolean {
    return this.#retainer.value !== null;
  }

  #cap(text: string): string {
    return text.length > this.maxChars ? text.slice(0, this.maxChars) : text;
  }

  async embed(text: string): Promise<Float32Array> {
    const pipe = await this.#retainer.get();
    try {
      const out = await pipe(this.#cap(text), {pooling: this.pooling, normalize: true});
      return (out.data as Float32Array).slice();
    } finally {
      await this.#retainer.release();
    }
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const pipe = await this.#retainer.get();
    let result: Float32Array[];
    try {
      const out = await pipe(
        texts.map(t => this.#cap(t)),
        {
          pooling: this.pooling,
          normalize: true
        }
      );
      const flat = out.data as Float32Array;
      result = [];
      for (let i = 0; i < texts.length; i++) {
        result.push(flat.slice(i * this.dim, (i + 1) * this.dim));
      }
    } finally {
      await this.#retainer.release();
    }

    // Detect non-finite vectors and retry singly. Empirically the NaN is
    // transient and isolated — retrying just the affected chunk on its own
    // (different batch shape, fresh ONNX call) almost always returns clean
    // output. Same workaround shape as aviatesk/obsidian-sonar PR #8.
    // retryNonFiniteVectors re-enters embed(), which takes its own retainer
    // ref — no need to hold one across this call.
    return retryNonFiniteVectors(
      texts,
      result,
      t => this.embed(t),
      {modelName: this.modelName, pooling: this.pooling},
      this.anomalyLogger
    );
  }

  async releaseRetained(): Promise<void> {
    // Nothing loaded → nothing to release. Skip the get()+release(true) cycle
    // so we don't allocate-and-destroy.
    if (this.#retainer.value === null) return;
    // get() cancels any pending retention timer and bumps counter to 1;
    // release(true) drops it back to 0 and destroys synchronously. If
    // another caller is mid-inference, counter stays > 0 after release and
    // the destroy is deferred until they finish — which is the correct
    // behavior for a "release now" trigger.
    await this.#retainer.get();
    await this.#retainer.release(true);
  }
}
