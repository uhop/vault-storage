// A stored frontmatter value outside its closed enum, recorded by the pass that
// dropped or defaulted it (schema 0032, D103): the file still says it, the
// database does not, and without a row nothing would.

import type {DatabaseSync, StatementSync} from 'node:sqlite';
import {prepared} from '../db/prepared.ts';

export type FmField = 'type' | 'status' | 'priority' | 'agent.complexity' | 'edges';

export interface FmFinding {
  field: FmField;
  value: string;
}

export interface FmFindingRow extends FmFinding {
  recordId: string;
  filePath: string;
  seenAt: string;
}

/** The fields the importer owns; the edge pass owns `edges`. */
export const IMPORTER_FM_FIELDS: readonly FmField[] = [
  'type',
  'status',
  'priority',
  'agent.complexity'
];

export class FmFindingsRepository {
  readonly #deleteField: StatementSync;
  readonly #insert: StatementSync;
  readonly #count: StatementSync;
  readonly #list: StatementSync;

  constructor(db: DatabaseSync) {
    this.#deleteField = prepared(db, 'DELETE FROM fm_findings WHERE record_id = ? AND field = ?');
    this.#insert = prepared(
      db,
      `INSERT INTO fm_findings (record_id, field, value, seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(record_id, field, value) DO UPDATE SET seen_at = excluded.seen_at`
    );
    this.#count = prepared(db, 'SELECT COUNT(*) AS n FROM fm_findings');
    this.#list = prepared(
      db,
      `SELECT f.record_id, r.file_path, f.field, f.value, f.seen_at
         FROM fm_findings f JOIN records r ON r.record_id = f.record_id
        ORDER BY r.file_path, f.field, f.value LIMIT ?`
    );
  }

  /** Replace what is recorded for these fields of one record with `findings`. */
  replace(
    recordId: string,
    fields: readonly FmField[],
    findings: readonly FmFinding[],
    now: string
  ): void {
    for (const field of fields) this.#deleteField.run(recordId, field);
    for (const f of findings) this.#insert.run(recordId, f.field, f.value, now);
  }

  count(): number {
    return (this.#count.get() as {n: number}).n;
  }

  list(limit: number): FmFindingRow[] {
    const rows = this.#list.all(limit) as unknown[] as {
      record_id: string;
      file_path: string;
      field: FmField;
      value: string;
      seen_at: string;
    }[];
    return rows.map(r => ({
      recordId: r.record_id,
      filePath: r.file_path,
      field: r.field,
      value: r.value,
      seenAt: r.seen_at
    }));
  }
}
