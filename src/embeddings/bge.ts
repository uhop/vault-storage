import {pipeline} from '@huggingface/transformers';
import type {FeatureExtractionPipeline} from '@huggingface/transformers';
import type {Embedder} from './types.ts';

const DEFAULT_MODEL = 'Xenova/bge-small-en-v1.5';
const DEFAULT_DIM = 384;

/**
 * Real embedder backed by transformers.js (`@huggingface/transformers`) running
 * a BGE ONNX model on CPU. Mean-pooled, L2-normalized — sqlite-vec dot-product
 * agrees with cosine similarity on the unit sphere.
 *
 * The pipeline is loaded lazily on the first call and reused; load + first
 * inference downloads the model (~33 MB) into the transformers.js cache.
 */
export class BgeEmbedder implements Embedder {
  readonly dim: number;
  readonly modelName: string;
  #pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  constructor(opts: {modelName?: string; dim?: number} = {}) {
    this.modelName = opts.modelName ?? DEFAULT_MODEL;
    this.dim = opts.dim ?? DEFAULT_DIM;
  }

  async embed(text: string): Promise<Float32Array> {
    const pipe = await this.#getPipeline();
    const out = await pipe(text, {pooling: 'mean', normalize: true});
    return (out.data as Float32Array).slice();
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const pipe = await this.#getPipeline();
    const out = await pipe(texts, {pooling: 'mean', normalize: true});
    const flat = out.data as Float32Array;
    const result: Float32Array[] = [];
    for (let i = 0; i < texts.length; i++) {
      result.push(flat.slice(i * this.dim, (i + 1) * this.dim));
    }
    return result;
  }

  #getPipeline(): Promise<FeatureExtractionPipeline> {
    if (!this.#pipelinePromise) {
      this.#pipelinePromise = pipeline('feature-extraction', this.modelName);
    }
    return this.#pipelinePromise;
  }
}
