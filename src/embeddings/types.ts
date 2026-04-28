/**
 * Embedder abstraction. Real implementations (transformers.js + BGE-small)
 * and test doubles (FakeEmbedder) both satisfy this interface. The wider
 * pipeline (importer, eval harness, search) accepts an Embedder; concrete
 * choice is wired at the entry point.
 */
export interface Embedder {
  /** Vector dimension. BGE-small produces 384. */
  readonly dim: number;
  /** Identifier used for cache invalidation when the model swaps. */
  readonly modelName: string;
  /** Embed one text into a `dim`-element float32 vector. */
  embed(text: string): Promise<Float32Array>;
  /** Embed many texts. Implementations may batch internally for throughput. */
  embedBatch(texts: string[]): Promise<Float32Array[]>;
}
