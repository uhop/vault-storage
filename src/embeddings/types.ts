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
  /**
   * True when the embedder is currently holding a loaded model (or other
   * heavyweight native resource) in memory. False right after construction
   * and after a release. Surfaced in `/system/status` so operators can see
   * whether an idle release has fired.
   */
  readonly retained: boolean;
  /**
   * Force-release retained native resources now. No-op when nothing is
   * loaded; defers when another caller is mid-inference (the destroy
   * happens after they finish). Used by `POST /maintenance/release-embedder`
   * to verify the idle path without waiting on the retention timer; the
   * normal release happens automatically after `retentionMs` of no use.
   */
  releaseRetained(): Promise<void>;
}
