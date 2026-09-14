import type {DatabaseSync} from 'node:sqlite';
import {meanPoolNormalize, RecordDocVecRepository} from '../db/doc-vec-repo.ts';
import {RecordVecRepository} from '../db/vec-repo.ts';
import {contentHash} from '../util/hash.ts';
import {chunkBody} from './chunker.ts';
import type {Embedder} from './types.ts';

export interface EmbedSummary {
  /** Records embedded this pass (new + refreshed). */
  embedded: number;
  /** Records skipped because chunks + content_hash already match. */
  upToDate: number;
  /** Total records inspected. */
  total: number;
  /** Total chunks written this pass. */
  chunksWritten: number;
  /** Chunks whose stored vector was reused instead of re-embedded (their text was unchanged). */
  chunksReused: number;
  /** Doc-level vectors written (one per record-with-chunks). */
  docVecsWritten: number;
  durationMs: number;
}

const DEFAULT_BATCH_SIZE = 32;

const isAllFinite = (v: Float32Array): boolean => {
  for (let i = 0; i < v.length; ++i) if (!Number.isFinite(v[i]!)) return false;
  return true;
};

interface PendingRow {
  record_id: string;
  body: string;
  content_hash: string;
  agent_summary: string | null;
}

/**
 * Compute embeddings for every record whose chunks are missing or whose
 * content_hash no longer matches the record's body. Chunks the body via
 * `chunkBody`, embeds each chunk, and replaces the record's chunk set
 * atomically per record. Idempotent: a second run over an unchanged vault
 * embeds nothing.
 *
 * Embedding runs **outside** the SQLite transaction (it's async); the
 * per-record upsert then writes within a per-batch transaction so the DB is
 * consistent at every commit boundary.
 */
export const embedPending = (
  db: DatabaseSync,
  embedder: Embedder,
  options: {batchSize?: number} = {}
): Promise<EmbedSummary> => {
  const run = (inFlight.get(db) ?? Promise.resolve()).then(() =>
    runEmbedPending(db, embedder, options)
  );
  inFlight.set(
    db,
    run.catch(() => {})
  );
  return run;
};

// Passes on one database run one at a time: the startup pass and a watcher drain
// that overlap would otherwise embed the same records twice.
const inFlight = new WeakMap<DatabaseSync, Promise<unknown>>();

const runEmbedPending = async (
  db: DatabaseSync,
  embedder: Embedder,
  options: {batchSize?: number}
): Promise<EmbedSummary> => {
  const start = performance.now();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  const totalRow = db.prepare('SELECT COUNT(*) AS n FROM records').get() as Record<
    string,
    unknown
  > as {n: number};
  const total = totalRow.n;

  // Records whose chunks are missing or stale. The chunks content_hash is
  // per-row but consistent within a record (set atomically together), so
  // any chunk's hash is sufficient. `r.content_hash` already incorporates
  // `agent_summary` (see `embedInputHash`), so a summary-only edit
  // invalidates here just like a body edit.
  const pendingStmt = db.prepare(
    `SELECT r.record_id, r.body, r.content_hash, r.agent_summary
       FROM records r
       LEFT JOIN (
         SELECT record_id, MAX(content_hash) AS content_hash
           FROM chunks
          GROUP BY record_id
       ) c ON c.record_id = r.record_id
      WHERE c.record_id IS NULL
         OR c.content_hash IS NULL
         OR c.content_hash != r.content_hash
      ORDER BY r.record_id`
  );
  const pending = pendingStmt.all() as unknown[] as PendingRow[];

  const vecs = new RecordVecRepository(db);
  const docVecs = new RecordDocVecRepository(db);
  let embedded = 0;
  let chunksWritten = 0;
  let docVecsWritten = 0;

  // Chunks are embedded in batches of `batchSize` across records; a chunk
  // whose text hash already has a stored vector for the record is reused, so
  // an edit re-embeds only the chunks it changed.
  type Pending = {
    row: PendingRow;
    texts: string[];
    hashes: string[];
    vectors: (Float32Array | null)[];
    missing: number[];
  };
  const buf: Pending[] = [];
  let bufChunkCount = 0;
  let chunksReused = 0;

  const flush = async (): Promise<void> => {
    if (buf.length === 0) return;
    const flatTexts: string[] = [];
    for (const p of buf) for (const i of p.missing) flatTexts.push(p.texts[i]!);
    const flatVecs = flatTexts.length ? await embedder.embedBatch(flatTexts) : [];

    let idx = 0;
    db.exec('BEGIN');
    try {
      for (const p of buf) {
        for (const i of p.missing) p.vectors[i] = flatVecs[idx++]!;
        const vecs_ = p.vectors as Float32Array[];
        // BGE / transformers.js occasionally produces a NaN chunk vector on
        // otherwise normal inputs (caught 2026-05-03 — 2 of 5701 live chunks
        // affected; root cause unknown, suspected tokenizer/ONNX edge case).
        // Drop the bad vectors here so neither record_vec nor record_doc_vec
        // ever stores NaN — a single NaN chunk poisons the mean-pool sum and
        // produces an all-NaN doc-vec, which sqlite-vec then returns as null
        // distance on every neighbour query. Hashes are dropped in step, so a
        // kept vector stays paired with the text it embeds.
        const kept = vecs_.flatMap((v, i) => (isAllFinite(v) ? [i] : []));
        const dropped = vecs_.length - kept.length;
        if (dropped > 0) {
          console.warn(
            `[embed] dropped ${dropped} non-finite chunk vector(s) of ${vecs_.length} for record ${p.row.record_id}`
          );
        }
        if (kept.length === 0) {
          // All chunks NaN — write the original anyway so we don't loop on
          // re-embed every pass; downstream consumers will see no doc-vec
          // (skipped below) and treat the record as not-similar to anything.
          // Loud warning so the situation gets investigated.
          console.warn(
            `[embed] every chunk for record ${p.row.record_id} was non-finite; persisting anyway to avoid re-embed loop`
          );
          vecs.setChunks(p.row.record_id, p.row.content_hash, vecs_);
          ++embedded;
          chunksWritten += vecs_.length;
          continue;
        }
        const cleanVecs = kept.map(i => vecs_[i]!);
        vecs.setChunks(
          p.row.record_id,
          p.row.content_hash,
          cleanVecs,
          kept.map(i => p.hashes[i]!)
        );
        // Doc-level vector: mean-pool the chunk vectors and L2-renormalize.
        // Drives whole-record operations (find-duplicates, clustering).
        // record_vec stays the source of truth for chunk-level retrieval.
        const doc = meanPoolNormalize(cleanVecs);
        if (doc !== null) {
          docVecs.setDocVec(p.row.record_id, p.row.content_hash, doc);
          docVecsWritten++;
        }
        embedded++;
        chunksWritten += cleanVecs.length;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    buf.length = 0;
    bufChunkCount = 0;
  };

  for (const row of pending) {
    const texts = chunkBody(row.body, {summary: row.agent_summary});
    if (texts.length === 0) continue;
    const hashes = texts.map(contentHash);
    const stored = vecs.getVectorsByTextHash(row.record_id);
    const vectors = hashes.map(h => {
      const v = stored.get(h);
      return v !== undefined && isAllFinite(v) ? v : null;
    });
    const missing = vectors.flatMap((v, i) => (v === null ? [i] : []));
    chunksReused += texts.length - missing.length;
    if (bufChunkCount + missing.length > batchSize && buf.length > 0) await flush();
    buf.push({row, texts, hashes, vectors, missing});
    bufChunkCount += missing.length;
    if (bufChunkCount >= batchSize) await flush();
  }
  await flush();

  return {
    embedded,
    upToDate: total - embedded,
    total,
    chunksWritten,
    chunksReused,
    docVecsWritten,
    durationMs: Math.round(performance.now() - start)
  };
};
