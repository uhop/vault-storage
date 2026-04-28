// Local types shim for `@huggingface/transformers`. The shipped `.d.ts`
// files have two pre-existing bugs (extension-less relative imports under
// `moduleResolution: nodenext` in `@huggingface/tokenizers`, and two
// `_call`/`batch_decode` covariance violations in
// `@huggingface/transformers/types/models/{lfm2_vl,mgp_str}`) that fail
// strict type-checking. Rather than disable lib-check globally, we redirect
// the type resolution for this package via `compilerOptions.paths` and
// declare a minimal surface covering only the API we actually use:
// `pipeline('feature-extraction', ...)` and the resulting callable
// `FeatureExtractionPipeline`. Runtime resolution is unaffected — Node
// continues to load the real package from `node_modules`.

declare module '@huggingface/transformers' {
  export interface Tensor {
    readonly data: Float32Array;
    readonly dims: readonly number[];
  }

  export interface FeatureExtractionPipelineOptions {
    pooling?: 'mean' | 'cls' | 'none';
    normalize?: boolean;
  }

  export interface FeatureExtractionPipeline {
    (
      texts: string | string[],
      options?: FeatureExtractionPipelineOptions
    ): Promise<Tensor>;
  }

  export function pipeline(
    task: 'feature-extraction',
    model?: string
  ): Promise<FeatureExtractionPipeline>;
}
