// Append-only JSONL log of embedding anomalies — currently just NaN/non-finite
// chunk vectors emitted by transformers.js + BGE on rare inputs (~0.035% of
// chunks empirically; non-deterministic, retry usually clears it). Each entry
// captures enough context (full chunk text, sha256, batch composition,
// retry outcome) to reproduce the failure offline.
//
// File path is configured via `VAULT_EMBED_ANOMALY_LOG`. Default location is
// `${VAULT_DATA_PATH}/.vault-storage/embed-nan.jsonl` — under the same
// vault-internal directory as `vault.sqlite`, which is already ignored by
// the file-watcher and by vault-data's `.gitignore` so the log doesn't
// bleed into auto-commit.

import {createHash} from 'node:crypto';
import {appendFile, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';

export type AnomalyStage = 'detected' | 'retry-succeeded' | 'retry-still-nan' | 'retry-threw';

export interface AnomalyEntry {
  /** ISO-8601 timestamp at the moment the anomaly (or its retry) was observed. */
  ts: string;
  stage: AnomalyStage;
  /** Embedder identity at the time of the failure (model + pooling). */
  modelName: string;
  pooling: string;
  /** Number of chunks in the original `embedBatch` call. */
  batchSize: number;
  /** 0-based index of the bad chunk within that batch. */
  batchIndex: number;
  /** The full chunk text — kept verbatim so the failure can be replayed offline. */
  chunk: string;
  chunkLength: number;
  /** sha256 of the chunk text — fast dedup key when triaging the log. */
  chunkSha256: string;
  /** Stringified error if a retry attempt threw. */
  error?: string;
}

export interface AnomalyLogger {
  log(entry: AnomalyEntry): Promise<void>;
}

/**
 * Append a JSON line per anomaly to a file on disk. Creates parent
 * directories on first write. Failures to append are logged to stderr but
 * never throw — the embedder should not be brought down by a log-write
 * problem.
 */
export class JsonlAnomalyLogger implements AnomalyLogger {
  readonly path: string;
  #ensuredDir = false;

  constructor(path: string) {
    this.path = path;
  }

  async log(entry: AnomalyEntry): Promise<void> {
    if (!this.#ensuredDir) {
      try {
        await mkdir(dirname(this.path), {recursive: true});
        this.#ensuredDir = true;
      } catch (err) {
        process.stderr.write(
          `[embed-nan] failed to create log dir ${dirname(this.path)}: ${String(err)}\n`
        );
        return;
      }
    }
    try {
      await appendFile(this.path, JSON.stringify(entry) + '\n', 'utf8');
    } catch (err) {
      process.stderr.write(`[embed-nan] failed to append ${this.path}: ${String(err)}\n`);
    }
  }
}

/** Build the per-anomaly entry given the chunk's surrounding context. */
export const buildAnomalyEntry = (args: {
  stage: AnomalyStage;
  modelName: string;
  pooling: string;
  batchSize: number;
  batchIndex: number;
  chunk: string;
  error?: string;
  now?: string;
}): AnomalyEntry => ({
  ts: args.now ?? new Date().toISOString(),
  stage: args.stage,
  modelName: args.modelName,
  pooling: args.pooling,
  batchSize: args.batchSize,
  batchIndex: args.batchIndex,
  chunk: args.chunk,
  chunkLength: args.chunk.length,
  chunkSha256: createHash('sha256').update(args.chunk, 'utf8').digest('hex'),
  ...(args.error !== undefined ? {error: args.error} : {})
});

const isAllFinite = (v: Float32Array): boolean => {
  for (let i = 0; i < v.length; ++i) if (!Number.isFinite(v[i]!)) return false;
  return true;
};

/**
 * Scan `vectors` for non-finite results, retry each affected chunk via
 * `embedSingle`, log every event (detected / retry-succeeded /
 * retry-still-nan / retry-threw) to stderr and the optional persistent
 * logger. Returns the (possibly patched) vectors in place — `vectors[i]`
 * is overwritten with the retry result when the retry succeeds; otherwise
 * the original (still non-finite) vector is left in place for the
 * downstream filter in `embedPending` to drop.
 *
 * Pure with respect to the embedder — takes `embedSingle` as a callback so
 * the retry path is testable without standing up transformers.js + BGE.
 */
export const retryNonFiniteVectors = async (
  texts: string[],
  vectors: Float32Array[],
  embedSingle: (text: string) => Promise<Float32Array>,
  context: {modelName: string; pooling: string},
  logger: AnomalyLogger | null
): Promise<Float32Array[]> => {
  for (let i = 0; i < vectors.length; ++i) {
    if (isAllFinite(vectors[i]!)) continue;
    const baseArgs = {
      modelName: context.modelName,
      pooling: context.pooling,
      batchSize: texts.length,
      batchIndex: i,
      chunk: texts[i]!
    };
    await emit(logger, buildAnomalyEntry({...baseArgs, stage: 'detected'}));
    let retried: Float32Array | null = null;
    try {
      retried = await embedSingle(texts[i]!);
    } catch (err) {
      await emit(
        logger,
        buildAnomalyEntry({
          ...baseArgs,
          stage: 'retry-threw',
          error: err instanceof Error ? err.message : String(err)
        })
      );
      continue;
    }
    if (isAllFinite(retried)) {
      vectors[i] = retried;
      await emit(logger, buildAnomalyEntry({...baseArgs, stage: 'retry-succeeded'}));
    } else {
      await emit(logger, buildAnomalyEntry({...baseArgs, stage: 'retry-still-nan'}));
    }
  }
  return vectors;
};

const emit = async (logger: AnomalyLogger | null, entry: AnomalyEntry): Promise<void> => {
  process.stderr.write(
    `[embed-nan] ${entry.stage} batch[${entry.batchIndex}/${entry.batchSize}] ` +
      `sha=${entry.chunkSha256.slice(0, 12)} len=${entry.chunkLength}` +
      (entry.error !== undefined ? ` error=${entry.error}` : '') +
      '\n'
  );
  if (logger) await logger.log(entry);
};
