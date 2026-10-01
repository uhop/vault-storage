// What changed in a project's notes and queue since a time (D117): a record's
// `modified_at`, stamped at the write, rather than a commit's time, which the
// auto-commit lags by up to two hours. A deletion leaves no record, so none is
// listed.

import type {DatabaseSync} from 'node:sqlite';
import type {SessionRecord} from './sessions.ts';
import {prepared} from '../db/prepared.ts';

export const CHANGES_CAP = 50;

export interface ChangedNote {
  path: string;
  title: string | null;
  modified_at: string;
}

export interface QueueChange {
  title: string;
  section: string;
}

export interface ProjectChanges {
  notes: ChangedNote[];
  /** Notes past the cap. */
  more: number;
  queue: {
    /** Items that entered a section: added, moved, or archived, since a move is a delete and an insert. */
    entered: QueueChange[];
    /** Items whose body changed in place. */
    edited: QueueChange[];
    more: number;
  };
}

/** The latest session that took a turn: it wrote a note, saw a commit, or wrote a log. */
export const lastWorkingSession = (sessions: readonly SessionRecord[]): SessionRecord | null =>
  sessions.find(s => s.wrote.length > 0 || s.commits.length > 0 || s.log !== null) ?? null;

// julianday() because stamps come with and without milliseconds, and as text
// `…30.123Z` sorts before `…30Z`.
export const projectChanges = (
  db: DatabaseSync,
  project: string,
  since: string
): ProjectChanges => {
  const prefix = `projects/${project}/`;
  const notes = prepared(
    db,
    `SELECT file_path, title, modified_at FROM records
        WHERE substr(file_path, 1, ?) = ? AND file_path != ?
          AND julianday(modified_at) > julianday(?)
        ORDER BY julianday(modified_at) DESC`
  ).all(prefix.length, prefix, `${prefix}sessions.md`, since) as unknown[] as {
    file_path: string;
    title: string | null;
    modified_at: string;
  }[];
  const items = prepared(
    db,
    `SELECT title, section, julianday(created_at) > julianday(?) AS entered FROM queue_items
        WHERE project = ? AND julianday(updated_at) > julianday(?)
        ORDER BY julianday(updated_at) DESC`
  ).all(since, project, since) as unknown[] as {title: string; section: string; entered: number}[];
  const kept = items.slice(0, CHANGES_CAP);
  return {
    notes: notes
      .slice(0, CHANGES_CAP)
      .map(n => ({path: n.file_path, title: n.title, modified_at: n.modified_at})),
    more: Math.max(0, notes.length - CHANGES_CAP),
    queue: {
      entered: kept.filter(i => i.entered).map(({title, section}) => ({title, section})),
      edited: kept.filter(i => !i.entered).map(({title, section}) => ({title, section})),
      more: Math.max(0, items.length - CHANGES_CAP)
    }
  };
};
