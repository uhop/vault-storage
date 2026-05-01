// SQLite snapshot mechanic for Tier 2 backup (per C2). Produces a single-
// file gzip-compressed SQLite snapshot via SQLite's VACUUM INTO, which is
// safe under concurrent reads/writes on a WAL database.
//
// Tier 2 preserves DB-only state — suggestions queue, embeddings,
// last_referenced timestamps — that Tier 1 (markdown git-sync) doesn't
// capture. Reconstructable from files in O(records) embed cost (~minutes),
// but the suggestions queue (agent review state) and last_referenced
// (decay anchors) would be lost without it.
//
// Architecture: the server produces the snapshot inside its own DB
// connection (where VACUUM INTO is safe under concurrent writes); the
// host-side picks the file up off the bind-mount and ships it offsite.
// Encryption keys, S3 credentials, and the upload tool (`jot`, `aws s3
// cp`, `rclone`, etc) all live on the host — none of them belong inside
// the container. See compose.yaml for the recommended host-cron snippet.

import {createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';
import type {DatabaseSync} from 'node:sqlite';

export interface SnapshotResult {
  path: string;
  bytes: number;
  durationMs: number;
}

/**
 * Snapshot the live SQLite database to `outputPath`. When the path ends
 * in `.gz`, the snapshot is gzip-compressed (the uncompressed temp file
 * is removed on success). Otherwise written as a plain SQLite file.
 *
 * Uses SQLite `VACUUM INTO` — a single atomic SQL statement that holds
 * a shared lock briefly. On a WAL database this is non-disruptive: in-
 * flight writes proceed normally; readers never block.
 */
export const snapshotDb = async (
  db: DatabaseSync,
  outputPath: string
): Promise<SnapshotResult> => {
  const start = performance.now();
  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, {recursive: true});

  const compressed = outputPath.endsWith('.gz');
  const sqlitePath = compressed ? `${outputPath}.tmp` : outputPath;

  // VACUUM INTO requires the destination to NOT exist (the statement
  // creates the file). Clear stale tmp / output if present.
  if (existsSync(sqlitePath)) unlinkSync(sqlitePath);
  if (compressed && existsSync(outputPath)) unlinkSync(outputPath);

  // Path is single-quote escaped per SQLite literal-string rules.
  const escaped = sqlitePath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);

  if (compressed) {
    await pipeline(createReadStream(sqlitePath), createGzip(), createWriteStream(outputPath));
    unlinkSync(sqlitePath);
  }

  return {
    path: outputPath,
    bytes: statSync(outputPath).size,
    durationMs: Math.round(performance.now() - start)
  };
};
