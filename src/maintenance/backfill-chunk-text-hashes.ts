// Fill `chunks.text_hash` (schema 0023) for records embedded before the column
// existed, so their next edit reuses unchanged chunks' vectors. Sound only for a
// chunk set whose `content_hash` equals the record's: the chunker's output last
// changed with the summary prefix (2026-04-30), which changed that hash too.

import type {DatabaseSync} from 'node:sqlite';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {chunkBody} from '../embeddings/chunker.ts';
import {contentHash} from '../util/hash.ts';

export interface ChunkTextHashBackfillSummary {
  /** Records whose chunks carried no text hash. */
  candidates: number;
  written: number;
  /** Candidates whose chunks no longer match the record, or whose count differs from the chunker's. */
  skipped: number;
  durationMs: number;
}

const BATCH_RECORDS = 50;

export const backfillChunkTextHashes = async (
  db: DatabaseSync
): Promise<ChunkTextHashBackfillSummary> => {
  const start = performance.now();
  const ids = (
    db
      .prepare(`SELECT DISTINCT record_id FROM chunks WHERE text_hash IS NULL ORDER BY record_id`)
      .all() as {record_id: string}[]
  ).map(r => r.record_id);

  // Re-read inside the batch's synchronous turn: an embed that landed since the
  // id list was taken may have replaced the chunk set.
  const state = db.prepare(
    `SELECT r.body AS body, r.agent_summary AS agent_summary, r.content_hash AS content_hash,
            COUNT(c.chunk_id) AS chunks, SUM(c.text_hash IS NULL) AS unhashed,
            MIN(c.content_hash) AS lo, MAX(c.content_hash) AS hi
       FROM records r
       JOIN chunks c ON c.record_id = r.record_id
      WHERE r.record_id = ?
      GROUP BY r.record_id`
  );
  const update = db.prepare('UPDATE chunks SET text_hash = ? WHERE chunk_id = ?');

  const summary: ChunkTextHashBackfillSummary = {
    candidates: ids.length,
    written: 0,
    skipped: 0,
    durationMs: 0
  };

  for (let offset = 0; offset < ids.length; offset += BATCH_RECORDS) {
    db.exec('BEGIN');
    try {
      for (const id of ids.slice(offset, offset + BATCH_RECORDS)) {
        const row = state.get(id) as
          | {
              body: string;
              agent_summary: string | null;
              content_hash: string;
              chunks: number;
              unhashed: number;
              lo: string;
              hi: string;
            }
          | undefined;
        const matches =
          row !== undefined &&
          row.unhashed === row.chunks &&
          row.lo === row.content_hash &&
          row.hi === row.content_hash;
        const texts = matches ? chunkBody(row.body, {summary: row.agent_summary}) : [];
        if (!matches || texts.length !== row.chunks) {
          ++summary.skipped;
          continue;
        }
        texts.forEach((text, i) => update.run(contentHash(text), `${id}:${i}`));
        ++summary.written;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    await nextTurn();
  }

  summary.durationMs = Math.round(performance.now() - start);
  return summary;
};
