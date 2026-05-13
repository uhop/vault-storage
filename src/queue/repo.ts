// Queue-items repository — DB layer over the `queue_items` table introduced
// by migration 0008. The parser produces `ParsedQueueItem[]` from a single
// queue.md or queue-archive.md file; `applyParsed()` reconciles that list
// against the DB slice keyed on `(project, source_file)`:
//
//   - Items in parse, missing from DB → INSERT with a fresh id, created_at=updated_at=now.
//   - Items in both, body_hash matches → UPDATE the cheap fields (position,
//     priority, section, source_line) only, leave created/updated alone.
//   - Items in both, body_hash differs → UPDATE everything, bump updated_at.
//   - Items in DB, missing from parse → DELETE.
//
// Identity for diffing within the slice is `(section, title_norm)` because
// the unique key includes section: a Backlog → Active move shows up as a
// DELETE + INSERT, which is what we want — title_norm collisions across
// sections are real (an item really did move).
//
// All reconciliation runs inside a single transaction so a parse-error or
// constraint violation mid-way doesn't leave the slice half-rebuilt.

import type {DatabaseSync, StatementSync} from 'node:sqlite';
import type {CloseReason, ParsedQueueItem, QueueSection} from './parse.ts';
import {uuidv7} from '../util/uuid.ts';

export interface QueueItemRow {
  id: string;
  project: string;
  section: QueueSection;
  priority: number;
  position: number;
  title: string;
  title_norm: string;
  body: string;
  closed_at: string | null;
  close_reason: CloseReason | null;
  source_file: string;
  source_line: number;
  body_hash: string;
  created_at: string;
  updated_at: string;
}

interface DbRow {
  id: string;
  project: string;
  section: string;
  priority: number;
  position: number;
  title: string;
  title_norm: string;
  body: string;
  closed_at: string | null;
  close_reason: string | null;
  source_file: string;
  source_line: number;
  body_hash: string;
  created_at: string;
  updated_at: string;
}

const rowFromDb = (row: DbRow): QueueItemRow => ({
  id: row.id,
  project: row.project,
  section: row.section as QueueSection,
  priority: row.priority,
  position: row.position,
  title: row.title,
  title_norm: row.title_norm,
  body: row.body,
  closed_at: row.closed_at,
  close_reason: row.close_reason as CloseReason | null,
  source_file: row.source_file,
  source_line: row.source_line,
  body_hash: row.body_hash,
  created_at: row.created_at,
  updated_at: row.updated_at
});

const sliceKey = (section: QueueSection, titleNorm: string): string =>
  `${section}\0${titleNorm}`;

export interface ApplyResult {
  inserted: number;
  /** Body changed; updated_at bumped. */
  updated: number;
  /** Body identical; only position/section/priority/source_line refreshed. */
  refreshed: number;
  deleted: number;
}

export class QueueItemsRepository {
  readonly #db: DatabaseSync;
  readonly #selectBySlice: StatementSync;
  readonly #insert: StatementSync;
  readonly #updateBody: StatementSync;
  readonly #refreshPlacement: StatementSync;
  readonly #deleteById: StatementSync;
  readonly #deleteBySource: StatementSync;

  readonly #listOpenByProject: StatementSync;
  readonly #listArchiveByProject: StatementSync;
  readonly #listTopOpen: StatementSync;
  readonly #listBySection: StatementSync;
  readonly #listByPriority: StatementSync;
  readonly #listAll: StatementSync;
  readonly #countAll: StatementSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#selectBySlice = db.prepare(
      'SELECT * FROM queue_items WHERE project = ? AND source_file = ?'
    );

    this.#insert = db.prepare(
      `INSERT INTO queue_items (
         id, project, section, priority, position, title, title_norm, body,
         closed_at, close_reason, source_file, source_line, body_hash,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    this.#updateBody = db.prepare(
      `UPDATE queue_items
         SET priority = ?, position = ?, title = ?, body = ?,
             closed_at = ?, close_reason = ?, source_line = ?,
             body_hash = ?, updated_at = ?
       WHERE id = ?`
    );

    this.#refreshPlacement = db.prepare(
      `UPDATE queue_items
         SET priority = ?, position = ?, source_line = ?
       WHERE id = ?`
    );

    this.#deleteById = db.prepare('DELETE FROM queue_items WHERE id = ?');
    this.#deleteBySource = db.prepare(
      'DELETE FROM queue_items WHERE project = ? AND source_file = ?'
    );

    this.#listOpenByProject = db.prepare(
      `SELECT * FROM queue_items
         WHERE project = ? AND section != 'archive'
         ORDER BY
           CASE section WHEN 'active' THEN 0 WHEN 'backlog' THEN 1 ELSE 2 END,
           priority DESC,
           position`
    );

    this.#listArchiveByProject = db.prepare(
      `SELECT * FROM queue_items
         WHERE project = ? AND section = 'archive'
         ORDER BY closed_at DESC NULLS LAST, position`
    );

    this.#listTopOpen = db.prepare(
      `SELECT * FROM queue_items
         WHERE section != 'archive'
         ORDER BY priority DESC, project, section, position
         LIMIT ?`
    );

    this.#listBySection = db.prepare(
      `SELECT * FROM queue_items
         WHERE section = ?
         ORDER BY priority DESC, project, position`
    );

    this.#listByPriority = db.prepare(
      `SELECT * FROM queue_items
         WHERE section = 'backlog' AND priority = ?
         ORDER BY project, position`
    );

    this.#listAll = db.prepare(`SELECT * FROM queue_items ORDER BY project, section, position`);
    this.#countAll = db.prepare('SELECT COUNT(*) AS n FROM queue_items');
  }

  /**
   * Reconcile the parsed list against the DB slice for one `(project, source_file)`.
   * Runs inside a savepoint so partial application is impossible.
   */
  applyParsed(
    project: string,
    sourceFile: string,
    parsed: ReadonlyArray<ParsedQueueItem>,
    now: string = new Date().toISOString()
  ): ApplyResult {
    // Guard: every parsed item must agree on project + source_file (callers
    // shouldn't be mixing slices through this entry point).
    for (const it of parsed) {
      if (it.project !== project || it.source_file !== sourceFile) {
        throw new Error(
          `applyParsed: parsed item ${JSON.stringify(it.title)} is in slice ` +
            `(${it.project}, ${it.source_file}) but caller passed (${project}, ${sourceFile})`
        );
      }
    }

    const existing = new Map<string, DbRow>();
    for (const row of this.#selectBySlice.all(project, sourceFile) as unknown as DbRow[]) {
      existing.set(sliceKey(row.section as QueueSection, row.title_norm), row);
    }

    const seen = new Set<string>();
    const result: ApplyResult = {inserted: 0, updated: 0, refreshed: 0, deleted: 0};

    // sqlite savepoint guards atomicity inside an outer transaction (if any);
    // standalone callers are still all-or-nothing.
    const db = this.#db;
    db.exec('SAVEPOINT queue_items_apply');
    try {
      for (const it of parsed) {
        const key = sliceKey(it.section, it.title_norm);
        seen.add(key);
        const prior = existing.get(key);

        if (!prior) {
          this.#insert.run(
            uuidv7(),
            it.project,
            it.section,
            it.priority,
            it.position,
            it.title,
            it.title_norm,
            it.body,
            it.closed_at,
            it.close_reason,
            it.source_file,
            it.source_line,
            it.body_hash,
            now,
            now
          );
          ++result.inserted;
          continue;
        }

        if (prior.body_hash !== it.body_hash) {
          this.#updateBody.run(
            it.priority,
            it.position,
            it.title,
            it.body,
            it.closed_at,
            it.close_reason,
            it.source_line,
            it.body_hash,
            now,
            prior.id
          );
          ++result.updated;
          continue;
        }

        const placementChanged =
          prior.priority !== it.priority ||
          prior.position !== it.position ||
          prior.source_line !== it.source_line;
        if (placementChanged) {
          this.#refreshPlacement.run(it.priority, it.position, it.source_line, prior.id);
          ++result.refreshed;
        }
      }

      for (const [key, row] of existing) {
        if (seen.has(key)) continue;
        this.#deleteById.run(row.id);
        ++result.deleted;
      }

      db.exec('RELEASE queue_items_apply');
    } catch (err) {
      db.exec('ROLLBACK TO queue_items_apply');
      db.exec('RELEASE queue_items_apply');
      throw err;
    }

    return result;
  }

  /** Drop every row for `(project, source_file)`. Used when a queue file is deleted. */
  deleteSlice(project: string, sourceFile: string): number {
    return this.#deleteBySource.run(project, sourceFile).changes as number;
  }

  /** Active + Backlog + Watching for one project, ordered by section then priority then position. */
  listOpenByProject(project: string): QueueItemRow[] {
    return (this.#listOpenByProject.all(project) as unknown as DbRow[]).map(rowFromDb);
  }

  /** Archive for one project, most-recent date first; undated rows last. */
  listArchiveByProject(project: string): QueueItemRow[] {
    return (this.#listArchiveByProject.all(project) as unknown as DbRow[]).map(rowFromDb);
  }

  /** Top N open items across the fleet, ordered by priority then project then section then position. */
  listTopOpen(limit: number): QueueItemRow[] {
    return (this.#listTopOpen.all(limit) as unknown as DbRow[]).map(rowFromDb);
  }

  /** Fleet-wide for one open section (active | backlog | watching). */
  listBySection(section: Exclude<QueueSection, 'archive'>): QueueItemRow[] {
    return (this.#listBySection.all(section) as unknown as DbRow[]).map(rowFromDb);
  }

  /** Fleet-wide for one priority tier in Backlog. */
  listByPriority(priority: number): QueueItemRow[] {
    return (this.#listByPriority.all(priority) as unknown as DbRow[]).map(rowFromDb);
  }

  listAll(): QueueItemRow[] {
    return (this.#listAll.all() as unknown as DbRow[]).map(rowFromDb);
  }

  count(): number {
    const row = this.#countAll.get() as {n: number};
    return row.n;
  }
}
