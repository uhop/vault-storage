// Per-file sync decision: pure logic, no I/O. The orchestrator
// (src/migration/sync.ts) reads files, calls into this, and writes results.
//
// Local-edit guard via 3-way merge:
//   - source (Obsidian, transformed): produced upstream
//   - target (vault-data on disk): the candidate write destination
//   - baseline: the hash of the content last written by a prior sync
// If the target's current hash differs from the recorded baseline, a local
// edit happened — we skip the file rather than stomp it.

import type {DatabaseSync, StatementSync} from 'node:sqlite';
import {contentHash} from '../util/hash.ts';

export type SyncAction =
  | 'new'
  | 'updated'
  | 'unchanged'
  | 'skipped_locally_newer'
  | 'skipped_atomized';

export interface SyncDecision {
  action: SyncAction;
  /** When `action` is 'new' or 'updated', this is the content to write. */
  contentToWrite?: string;
  /** When `action` is 'new' or 'updated' or 'unchanged', this is the new baseline hash. */
  newBaselineHash?: string;
  /** Human-readable note for the per-pass log. */
  note?: string;
}

export interface DecideArgs {
  /** Transformed source content (the candidate write — already through `transformFile`). */
  transformed: string;
  /** Current target content, or null if the target file doesn't exist. */
  target: string | null;
  /** Whether `<targetStem>/_about.md` exists — i.e., the target was atomized. */
  targetIsAtomized: boolean;
  /** Recorded baseline hash from the last successful sync, or null on first run. */
  baseline: string | null;
}

export const decideSync = (args: DecideArgs): SyncDecision => {
  const transformedHash = contentHash(args.transformed);

  if (args.targetIsAtomized) {
    return {
      action: 'skipped_atomized',
      note: 'target was atomized into a folder of pieces; per-file sync would conflict'
    };
  }

  if (args.target === null) {
    return {
      action: 'new',
      contentToWrite: args.transformed,
      newBaselineHash: transformedHash
    };
  }

  if (args.target === args.transformed) {
    return {action: 'unchanged', newBaselineHash: transformedHash};
  }

  const targetHash = contentHash(args.target);

  if (args.baseline === null) {
    return {
      action: 'skipped_locally_newer',
      note: 'no sync baseline recorded; assume target is locally authored'
    };
  }
  if (args.baseline !== targetHash) {
    return {
      action: 'skipped_locally_newer',
      note: 'target diverged from last-synced baseline (local edit)'
    };
  }

  return {
    action: 'updated',
    contentToWrite: args.transformed,
    newBaselineHash: transformedHash
  };
};

/** CRUD over the sync_baseline table. */
export class SyncBaselineRepository {
  readonly #get: StatementSync;
  readonly #upsert: StatementSync;
  readonly #listPaths: StatementSync;
  readonly #delete: StatementSync;

  constructor(db: DatabaseSync) {
    this.#get = db.prepare('SELECT content_hash FROM sync_baseline WHERE file_path = ?');
    this.#upsert = db.prepare(
      `INSERT INTO sync_baseline (file_path, content_hash, synced_at)
       VALUES (?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         content_hash = excluded.content_hash,
         synced_at    = excluded.synced_at`
    );
    this.#listPaths = db.prepare('SELECT file_path FROM sync_baseline');
    this.#delete = db.prepare('DELETE FROM sync_baseline WHERE file_path = ?');
  }

  get(filePath: string): string | null {
    const row = this.#get.get(filePath) as Record<string, unknown> | undefined as
      | {content_hash: string}
      | undefined;
    return row?.content_hash ?? null;
  }

  upsert(filePath: string, contentHashValue: string, syncedAtIso: string): void {
    this.#upsert.run(filePath, contentHashValue, syncedAtIso);
  }

  listPaths(): string[] {
    return (this.#listPaths.all() as unknown[] as {file_path: string}[]).map(r => r.file_path);
  }

  delete(filePath: string): void {
    this.#delete.run(filePath);
  }
}
