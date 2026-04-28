import type {DatabaseSync, StatementSync} from 'node:sqlite';
import type {RecordStatus, RecordType, VaultRecord} from './types.ts';

interface RecordRow {
  record_id: string;
  file_path: string;
  parent_path: string | null;
  sequence_key: number | null;
  type: string;
  body: string;
  content_hash: string;
  created: string;
  updated: string;
  last_referenced: string | null;
  decay_score: number;
  status: string;
  priority: number;
  archived_at: string | null;
}

const rowToRecord = (row: RecordRow): VaultRecord => ({
  recordId: row.record_id,
  filePath: row.file_path,
  parentPath: row.parent_path,
  sequenceKey: row.sequence_key,
  type: row.type as RecordType,
  body: row.body,
  contentHash: row.content_hash,
  created: row.created,
  updated: row.updated,
  lastReferenced: row.last_referenced,
  decayScore: row.decay_score,
  status: row.status as RecordStatus,
  priority: row.priority,
  archivedAt: row.archived_at
});

export class RecordsRepository {
  readonly #insert: StatementSync;
  readonly #upsert: StatementSync;
  readonly #getById: StatementSync;
  readonly #getByPath: StatementSync;
  readonly #delete: StatementSync;
  readonly #listByParent: StatementSync;
  readonly #countAll: StatementSync;

  constructor(db: DatabaseSync) {
    this.#insert = db.prepare(
      `INSERT INTO records (
         record_id, file_path, parent_path, sequence_key, type, body, content_hash,
         created, updated, last_referenced, decay_score, status, priority, archived_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    // Upsert keyed on file_path. ON CONFLICT preserves record_id and created.
    this.#upsert = db.prepare(
      `INSERT INTO records (
         record_id, file_path, parent_path, sequence_key, type, body, content_hash,
         created, updated, last_referenced, decay_score, status, priority, archived_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(file_path) DO UPDATE SET
         parent_path     = excluded.parent_path,
         sequence_key    = excluded.sequence_key,
         type            = excluded.type,
         body            = excluded.body,
         content_hash    = excluded.content_hash,
         updated         = excluded.updated,
         last_referenced = excluded.last_referenced,
         decay_score     = excluded.decay_score,
         status          = excluded.status,
         priority        = excluded.priority,
         archived_at     = excluded.archived_at`
    );

    this.#getById = db.prepare('SELECT * FROM records WHERE record_id = ?');
    this.#getByPath = db.prepare('SELECT * FROM records WHERE file_path = ?');
    this.#delete = db.prepare('DELETE FROM records WHERE record_id = ?');
    this.#listByParent = db.prepare(
      'SELECT * FROM records WHERE parent_path = ? ORDER BY sequence_key, created'
    );
    this.#countAll = db.prepare('SELECT COUNT(*) AS n FROM records');
  }

  insert(r: VaultRecord): void {
    this.#insert.run(
      r.recordId,
      r.filePath,
      r.parentPath,
      r.sequenceKey,
      r.type,
      r.body,
      r.contentHash,
      r.created,
      r.updated,
      r.lastReferenced,
      r.decayScore,
      r.status,
      r.priority,
      r.archivedAt
    );
  }

  /** Insert or update by `file_path`. Preserves record_id and created on update. */
  upsertByPath(r: VaultRecord): void {
    this.#upsert.run(
      r.recordId,
      r.filePath,
      r.parentPath,
      r.sequenceKey,
      r.type,
      r.body,
      r.contentHash,
      r.created,
      r.updated,
      r.lastReferenced,
      r.decayScore,
      r.status,
      r.priority,
      r.archivedAt
    );
  }

  getById(id: string): VaultRecord | null {
    const row = this.#getById.get(id) as Record<string, unknown> | undefined as
      | RecordRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  getByPath(path: string): VaultRecord | null {
    const row = this.#getByPath.get(path) as Record<string, unknown> | undefined as
      | RecordRow
      | undefined;
    return row ? rowToRecord(row) : null;
  }

  delete(id: string): boolean {
    const result = this.#delete.run(id);
    return result.changes > 0;
  }

  listByParent(parentPath: string): VaultRecord[] {
    return (this.#listByParent.all(parentPath) as unknown[] as RecordRow[]).map(rowToRecord);
  }

  count(): number {
    // COUNT(*) always returns one row, so undefined isn't reachable here.
    const row = this.#countAll.get() as Record<string, unknown> as {n: number};
    return row.n;
  }
}
