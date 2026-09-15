import type {DatabaseSync} from 'node:sqlite';
import {meanPoolNormalize, RecordDocVecRepository} from '../db/doc-vec-repo.ts';
import {RecordSummaryVecRepository} from '../db/summary-vec-repo.ts';
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
  /** Summary vectors written; a summary whose text did not change reuses its vector. */
  summaryVecsWritten: number;
  /** Records still pending when the pass stopped at `maxEmbeds`; 0 when it finished. */
  remaining: number;
  durationMs: number;
}

export interface EmbedOptions {
  batchSize?: number;
  /**
   * Stop taking records once this many texts were sent to the model. The
   * record that crosses the budget still completes, since its chunk set is
   * replaced whole. Default: no limit.
   */
  maxEmbeds?: number;
}

/**
 * A round's budget for callers that share the model: passes on one database
 * queue, so a new edit waits for at most the round ahead of it.
 */
export const EMBED_ROUND = 64;

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
 * Compute embeddings for the records whose chunks, or summary vector, are
 * missing or carry a content_hash other than the record's, most recently
 * modified first. Chunks the body via `chunkBody`, embeds each chunk and the
 * `agent.summary` on its own, and replaces the record's vectors atomically
 * per record. Idempotent: a second run over an
 * unchanged vault embeds nothing. With `maxEmbeds` this is one round, and
 * `remaining` says whether another is due; {@link embedAllPending} loops.
 *
 * Embedding runs **outside** the SQLite transaction (it's async); the
 * per-record upsert then writes within a per-batch transaction so the DB is
 * consistent at every commit boundary.
 */
export const embedPending = (
  db: DatabaseSync,
  embedder: Embedder,
  options: EmbedOptions = {}
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

/**
 * Rounds of {@link embedPending} until nothing is pending. Each round queues
 * anew, so other passes run between rounds instead of behind the whole backlog.
 */
export const embedAllPending = async (
  db: DatabaseSync,
  embedder: Embedder,
  options: EmbedOptions = {}
): Promise<EmbedSummary> => {
  const start = performance.now();
  const round = {maxEmbeds: EMBED_ROUND, ...options};
  const sum: EmbedSummary = {
    embedded: 0,
    upToDate: 0,
    total: 0,
    chunksWritten: 0,
    chunksReused: 0,
    docVecsWritten: 0,
    summaryVecsWritten: 0,
    remaining: 0,
    durationMs: 0
  };
  for (;;) {
    const r = await embedPending(db, embedder, round);
    sum.embedded += r.embedded;
    sum.chunksWritten += r.chunksWritten;
    sum.chunksReused += r.chunksReused;
    sum.docVecsWritten += r.docVecsWritten;
    sum.summaryVecsWritten += r.summaryVecsWritten;
    sum.total = r.total;
    if (r.remaining === 0) break;
  }
  sum.upToDate = Math.max(0, sum.total - sum.embedded);
  sum.durationMs = Math.round(performance.now() - start);
  return sum;
};

const runEmbedPending = async (
  db: DatabaseSync,
  embedder: Embedder,
  options: EmbedOptions
): Promise<EmbedSummary> => {
  const start = performance.now();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxEmbeds = options.maxEmbeds ?? Infinity;

  const totalRow = db.prepare('SELECT COUNT(*) AS n FROM records').get() as Record<
    string,
    unknown
  > as {n: number};
  const total = totalRow.n;

  // Records whose chunks or summary vector are missing or stale. A record's
  // chunks share one content_hash (set atomically together). `r.content_hash`
  // incorporates `agent_summary` (see `embedInputHash`), so a summary-only edit
  // is pending too, and reuses every chunk. Ids only, bodies per record: a
  // round reads the pending list again, and a backlog's bodies are megabytes.
  const pending = (
    db
      .prepare(
        `SELECT r.record_id
           FROM records r
          WHERE NOT EXISTS (
                  SELECT 1 FROM chunks c
                   WHERE c.record_id = r.record_id AND c.content_hash = r.content_hash)
             OR (r.agent_summary IS NOT NULL AND r.agent_summary != ''
                 AND NOT EXISTS (
                   SELECT 1 FROM record_summaries s
                    WHERE s.record_id = r.record_id AND s.content_hash = r.content_hash))
          ORDER BY r.modified_at DESC, r.record_id`
      )
      .all() as {record_id: string}[]
  ).map(r => r.record_id);
  const rowStmt = db.prepare(
    'SELECT record_id, body, content_hash, agent_summary FROM records WHERE record_id = ?'
  );

  const vecs = new RecordVecRepository(db);
  const docVecs = new RecordDocVecRepository(db);
  const summaries = new RecordSummaryVecRepository(db);
  let embedded = 0;
  let chunksWritten = 0;
  let docVecsWritten = 0;
  let summaryVecsWritten = 0;

  // Chunks are embedded in batches of `batchSize` across records; a chunk
  // whose text hash already has a stored vector for the record is reused, so
  // an edit re-embeds only the chunks it changed.
  type Pending = {
    row: PendingRow;
    texts: string[];
    hashes: string[];
    vectors: (Float32Array | null)[];
    missing: number[];
    summary: {text: string; hash: string; vector: Float32Array | null} | null;
  };
  const buf: Pending[] = [];
  let bufChunkCount = 0;
  let chunksReused = 0;

  const flush = async (): Promise<void> => {
    if (buf.length === 0) return;
    const flatTexts: string[] = [];
    for (const p of buf) {
      for (const i of p.missing) flatTexts.push(p.texts[i]!);
      if (p.summary?.vector === null) flatTexts.push(p.summary.text);
    }
    const flatVecs = flatTexts.length ? await embedder.embedBatch(flatTexts) : [];

    let idx = 0;
    db.exec('BEGIN');
    try {
      for (const p of buf) {
        for (const i of p.missing) p.vectors[i] = flatVecs[idx++]!;
        if (p.summary === null) {
          summaries.delete(p.row.record_id);
        } else {
          const vector = p.summary.vector ?? flatVecs[idx++]!;
          // A non-finite vector is stored without its text hash: never reused,
          // and the record stops being pending instead of looping every round.
          const finite = isAllFinite(vector);
          if (!finite) {
            console.warn(`[embed] non-finite summary vector for record ${p.row.record_id}`);
          }
          summaries.set(
            p.row.record_id,
            p.row.content_hash,
            finite ? p.summary.hash : null,
            vector
          );
          ++summaryVecsWritten;
        }
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

  let taken = 0;
  let sent = 0;
  for (const id of pending) {
    if (sent >= maxEmbeds) break;
    ++taken;
    const row = rowStmt.get(id) as PendingRow | undefined;
    if (!row) continue;
    const texts = chunkBody(row.body);
    if (texts.length === 0) continue;
    const hashes = texts.map(contentHash);
    const stored = vecs.getVectorsByTextHash(row.record_id);
    const vectors = hashes.map(h => {
      const v = stored.get(h);
      return v !== undefined && isAllFinite(v) ? v : null;
    });
    const missing = vectors.flatMap((v, i) => (v === null ? [i] : []));
    chunksReused += texts.length - missing.length;
    let summary: Pending['summary'] = null;
    if (row.agent_summary) {
      const hash = contentHash(row.agent_summary);
      const storedSummary = summaries.get(row.record_id);
      const reusable = storedSummary?.textHash === hash && isAllFinite(storedSummary.embedding);
      summary = {text: row.agent_summary, hash, vector: reusable ? storedSummary.embedding : null};
    }
    const toEmbed = missing.length + (summary?.vector === null ? 1 : 0);
    sent += toEmbed;
    if (bufChunkCount + toEmbed > batchSize && buf.length > 0) await flush();
    buf.push({row, texts, hashes, vectors, missing, summary});
    bufChunkCount += toEmbed;
    if (bufChunkCount >= batchSize) await flush();
  }
  await flush();

  const remaining = pending.length - taken;
  return {
    embedded,
    upToDate: total - embedded - remaining,
    total,
    chunksWritten,
    chunksReused,
    docVecsWritten,
    summaryVecsWritten,
    remaining,
    durationMs: Math.round(performance.now() - start)
  };
};
