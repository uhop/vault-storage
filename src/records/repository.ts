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
  body_hash: string;
  title: string | null;
  created: string;
  updated: string;
  modified_at: string | null;
  last_referenced: string | null;
  decay_score: number;
  status: string;
  priority: number;
  archived_at: string | null;
  agent_summary: string | null;
  agent_derived_from_hash: string | null;
}

const rowToRecord = (row: RecordRow): VaultRecord => ({
  recordId: row.record_id,
  filePath: row.file_path,
  parentPath: row.parent_path,
  sequenceKey: row.sequence_key,
  type: row.type as RecordType,
  body: row.body,
  contentHash: row.content_hash,
  bodyHash: row.body_hash,
  title: row.title,
  created: row.created,
  updated: row.updated,
  modifiedAt: row.modified_at,
  lastReferenced: row.last_referenced,
  decayScore: row.decay_score,
  status: row.status as RecordStatus,
  priority: row.priority,
  archivedAt: row.archived_at,
  agentSummary: row.agent_summary,
  agentDerivedFromHash: row.agent_derived_from_hash
});

// Explicit column list for full-record reads — column-order-independent
// (the 0011 rebuild moved big text columns last) and a visible inventory
// of what a "full" read materializes. Exported for handlers that build
// their own list queries over records (GET /sections).
export const RECORD_COLUMNS = `record_id, file_path, parent_path, sequence_key, type, body, content_hash,
   body_hash, title, created, updated, modified_at, last_referenced, decay_score, status, priority,
   archived_at, agent_summary, agent_derived_from_hash`;

export class RecordsRepository {
  readonly #insert: StatementSync;
  readonly #upsert: StatementSync;
  readonly #getById: StatementSync;
  readonly #getByPath: StatementSync;
  readonly #delete: StatementSync;
  readonly #listByParent: StatementSync;
  readonly #listAll: StatementSync;
  readonly #countAll: StatementSync;
  readonly #bumpLastReferenced: StatementSync;
  readonly #updateFilePath: StatementSync;
  readonly #bumpGeneration: StatementSync;

  constructor(db: DatabaseSync) {
    // modified_at is DB-stamped (strftime 'now', UTC, ms precision), not a
    // bound param — every write re-stamps it. See schema 0012.
    this.#insert = db.prepare(
      `INSERT INTO records (
         record_id, file_path, parent_path, sequence_key, type, body, content_hash, body_hash,
         title, created, updated, last_referenced, decay_score, status, priority, archived_at,
         agent_summary, agent_derived_from_hash, modified_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
    );

    // Upsert keyed on file_path. ON CONFLICT preserves record_id and created.
    this.#upsert = db.prepare(
      `INSERT INTO records (
         record_id, file_path, parent_path, sequence_key, type, body, content_hash, body_hash,
         title, created, updated, last_referenced, decay_score, status, priority, archived_at,
         agent_summary, agent_derived_from_hash, modified_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(file_path) DO UPDATE SET
         parent_path             = excluded.parent_path,
         sequence_key            = excluded.sequence_key,
         type                    = excluded.type,
         body                    = excluded.body,
         content_hash            = excluded.content_hash,
         body_hash               = excluded.body_hash,
         title                   = excluded.title,
         updated                 = excluded.updated,
         last_referenced         = excluded.last_referenced,
         decay_score             = excluded.decay_score,
         status                  = excluded.status,
         priority                = excluded.priority,
         archived_at             = excluded.archived_at,
         agent_summary           = excluded.agent_summary,
         agent_derived_from_hash = excluded.agent_derived_from_hash,
         modified_at             = strftime('%Y-%m-%dT%H:%M:%fZ','now')`
    );

    this.#getById = db.prepare(`SELECT ${RECORD_COLUMNS} FROM records WHERE record_id = ?`);
    this.#getByPath = db.prepare(`SELECT ${RECORD_COLUMNS} FROM records WHERE file_path = ?`);
    this.#delete = db.prepare('DELETE FROM records WHERE record_id = ?');
    this.#listByParent = db.prepare(
      `SELECT ${RECORD_COLUMNS} FROM records WHERE parent_path = ? ORDER BY sequence_key, created`
    );
    this.#listAll = db.prepare(`SELECT ${RECORD_COLUMNS} FROM records ORDER BY file_path`);
    this.#countAll = db.prepare('SELECT COUNT(*) AS n FROM records');
    this.#bumpLastReferenced = db.prepare(
      'UPDATE records SET last_referenced = ? WHERE record_id = ?'
    );
    this.#updateFilePath = db.prepare('UPDATE records SET file_path = ? WHERE record_id = ?');

    // Content-generation bump (see src/db/meta.ts CONTENT_GENERATION_KEY):
    // every content-shaping mutation below increments the counter so the
    // C8.1 scan scheduler can tell "vault changed since the last pass"
    // without fingerprinting record content. Read paths (bumpLastReferenced)
    // deliberately don't touch it.
    this.#bumpGeneration = db.prepare(
      `INSERT INTO meta (key, value) VALUES ('content_generation', '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`
    );
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
      r.bodyHash,
      r.title,
      r.created,
      r.updated,
      r.lastReferenced,
      r.decayScore,
      r.status,
      r.priority,
      r.archivedAt,
      r.agentSummary,
      r.agentDerivedFromHash
    );
    this.#bumpGeneration.run();
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
      r.bodyHash,
      r.title,
      r.created,
      r.updated,
      r.lastReferenced,
      r.decayScore,
      r.status,
      r.priority,
      r.archivedAt,
      r.agentSummary,
      r.agentDerivedFromHash
    );
    this.#bumpGeneration.run();
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
    if (result.changes > 0) this.#bumpGeneration.run();
    return result.changes > 0;
  }

  /**
   * Update only `file_path`, preserving `record_id` and every other column.
   * Used by `POST /vault/move` to rename a file without rebuilding edges,
   * embeddings, or refiling suggestions — body content_hash is unchanged
   * so derived state remains valid; only the path field needs to follow.
   */
  updateFilePath(recordId: string, newFilePath: string): boolean {
    const result = this.#updateFilePath.run(newFilePath, recordId);
    if (result.changes > 0) this.#bumpGeneration.run();
    return result.changes > 0;
  }

  listByParent(parentPath: string): VaultRecord[] {
    return (this.#listByParent.all(parentPath) as unknown[] as RecordRow[]).map(rowToRecord);
  }

  listAll(): VaultRecord[] {
    return (this.#listAll.all() as unknown[] as RecordRow[]).map(rowToRecord);
  }

  count(): number {
    // COUNT(*) always returns one row, so undefined isn't reachable here.
    const row = this.#countAll.get() as Record<string, unknown> as {n: number};
    return row.n;
  }

  /**
   * Update `last_referenced` to mark a record as freshly read by an agent
   * or user. Per Phase E (decay), single-record reads (GET /sections/{id},
   * /vault/{path}, /sections/{id}/{neighborhood,similar,backlinks}) bump
   * this timestamp; bulk listings do not. Used by the lazy decay-score
   * computation: `score = exp(-lambda * (now - last_referenced) / day)`.
   */
  bumpLastReferenced(recordId: string, now: string = new Date().toISOString()): void {
    this.#bumpLastReferenced.run(now, recordId);
  }
}
