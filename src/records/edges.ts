import type {DatabaseSync, StatementSync} from 'node:sqlite';
import type {Edge, EdgeType} from './types.ts';

interface EdgeRow {
  from_id: string;
  to_id: string;
  type: string;
  weight: number;
  note: string | null;
  created: string;
}

const rowToEdge = (row: EdgeRow): Edge => ({
  fromId: row.from_id,
  toId: row.to_id,
  type: row.type as EdgeType,
  weight: row.weight,
  note: row.note,
  created: row.created
});

export class EdgesRepository {
  readonly #insert: StatementSync;
  readonly #delete: StatementSync;
  readonly #listOutbound: StatementSync;
  readonly #listInbound: StatementSync;
  readonly #listByType: StatementSync;

  constructor(db: DatabaseSync) {
    this.#insert = db.prepare(
      `INSERT INTO edges (from_id, to_id, type, weight, note, created)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(from_id, to_id, type) DO UPDATE SET
         weight = excluded.weight,
         note   = excluded.note`
    );
    this.#delete = db.prepare('DELETE FROM edges WHERE from_id = ? AND to_id = ? AND type = ?');
    this.#listOutbound = db.prepare('SELECT * FROM edges WHERE from_id = ? ORDER BY type, to_id');
    this.#listInbound = db.prepare('SELECT * FROM edges WHERE to_id = ? ORDER BY type, from_id');
    this.#listByType = db.prepare('SELECT * FROM edges WHERE type = ? ORDER BY created');
  }

  /** Idempotent insert keyed on (from_id, to_id, type). Updates weight + note on re-insert. */
  upsert(edge: Edge): void {
    this.#insert.run(edge.fromId, edge.toId, edge.type, edge.weight, edge.note, edge.created);
  }

  delete(fromId: string, toId: string, type: EdgeType): boolean {
    return this.#delete.run(fromId, toId, type).changes > 0;
  }

  listOutbound(fromId: string): Edge[] {
    return (this.#listOutbound.all(fromId) as unknown as EdgeRow[]).map(rowToEdge);
  }

  listInbound(toId: string): Edge[] {
    return (this.#listInbound.all(toId) as unknown as EdgeRow[]).map(rowToEdge);
  }

  listByType(type: EdgeType): Edge[] {
    return (this.#listByType.all(type) as unknown as EdgeRow[]).map(rowToEdge);
  }
}
