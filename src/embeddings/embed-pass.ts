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
  /** Clock for the retry backoff of incomplete records; tests pass their own. */
  now?: () => number;
}

/**
 * A round's budget for callers that share the model: passes on one database
 * queue, so a new edit waits for at most the round ahead of it.
 */
export const EMBED_ROUND = 64;

const DEFAULT_BATCH_SIZE = 32;

/**
 * A record some of whose vectors came back non-finite is stored under this hash
 * instead of its own: its finite vectors still serve search, lint reports it as
 * embedding drift, and it is pending again once its backoff runs out.
 */
const INCOMPLETE = '';
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 3_600_000;

interface Failure {
  contentHash: string;
  attempts: number;
  retryAt: number;
}

// Per process: the non-finite vectors seen on croc came in bursts that retrying
// within the same batch did not clear, while the same texts embedded later came
// back finite, so a failed record waits before it is taken again.
const failures = new WeakMap<DatabaseSync, Map<string, Failure>>();

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
  const now = (options.now ?? Date.now)();
  let failed = failures.get(db);
  if (!failed) {
    failed = new Map();
    failures.set(db, failed);
  }

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
        `SELECT r.record_id, r.content_hash
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
      .all() as {record_id: string; content_hash: string}[]
  )
    .filter(r => {
      const f = failed.get(r.record_id);
      return !f || f.contentHash !== r.content_hash || f.retryAt <= now;
    })
    .map(r => r.record_id);
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
        const id = p.row.record_id;
        for (const i of p.missing) p.vectors[i] = flatVecs[idx++]!;
        const summaryVector = p.summary === null ? null : (p.summary.vector ?? flatVecs[idx++]!);
        const vecs_ = p.vectors as Float32Array[];
        // Non-finite chunk vectors are not stored beside finite ones: one NaN in
        // the mean pool makes the doc vector NaN, and sqlite-vec then returns null
        // for every neighbour distance. Hashes drop in step with their vectors.
        const kept = vecs_.flatMap((v, i) => (isAllFinite(v) ? [i] : []));
        const summaryFinite = summaryVector === null || isAllFinite(summaryVector);
        const complete = kept.length === vecs_.length && summaryFinite;
        const hash = complete ? p.row.content_hash : INCOMPLETE;
        if (complete) {
          failed.delete(id);
        } else {
          const prior = failed.get(id);
          const attempts = prior?.contentHash === p.row.content_hash ? prior.attempts + 1 : 1;
          const delay = Math.min(RETRY_FIRST_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
          failed.set(id, {contentHash: p.row.content_hash, attempts, retryAt: now + delay});
          console.warn(
            `[embed] record ${id}: ${vecs_.length - kept.length} of ${vecs_.length} chunk vector(s)` +
              `${summaryFinite ? '' : ' and the summary vector'} non-finite; ` +
              `stored incomplete, retry ${attempts} in ${delay / 1000} s`
          );
        }
        if (p.summary === null) {
          summaries.delete(id);
        } else {
          // A non-finite vector keeps no text hash, so a retry never reuses it.
          summaries.set(id, hash, summaryFinite ? p.summary.hash : null, summaryVector!);
          ++summaryVecsWritten;
        }
        if (kept.length === 0) {
          // Stored anyway, without a doc vector, so the record reads as incomplete
          // rather than as never embedded.
          vecs.setChunks(id, hash, vecs_);
          ++embedded;
          chunksWritten += vecs_.length;
          continue;
        }
        const cleanVecs = kept.map(i => vecs_[i]!);
        vecs.setChunks(
          id,
          hash,
          cleanVecs,
          kept.map(i => p.hashes[i]!)
        );
        // Doc-level vector: mean-pool the chunk vectors and L2-renormalize.
        // Drives whole-record operations (find-duplicates, clustering).
        // record_vec stays the source of truth for chunk-level retrieval.
        const doc = meanPoolNormalize(cleanVecs);
        if (doc !== null) {
          docVecs.setDocVec(id, hash, doc);
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
