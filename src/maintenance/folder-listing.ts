// Folder-listing scanner. Returns the direct children of a vault folder
// — subfolders + records — with FM-derived metadata on each file.
// Backs GET /maintenance/folder-listing for the browse UI.
//
// Only sees content the indexer knows about (the `records` table). Files
// that didn't pass through the importer (binary attachments, skip-listed
// names) are invisible. For a vault that's nearly all markdown this is
// the right tradeoff — one DB query, no filesystem walk.

import type {DatabaseSync} from 'node:sqlite';

export interface FolderFile {
  path: string;
  title: string | null;
  type: string;
  status: string;
  updated: string;
}

export interface FolderListing {
  path: string;
  subfolders: string[];
  files: FolderFile[];
}

interface RecordRow {
  file_path: string;
  title: string | null;
  type: string;
  status: string;
  updated: string;
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

/**
 * Normalize a folder path: strip leading and trailing slashes, collapse
 * runs of slashes. Empty input → empty (vault root).
 */
const normalize = (raw: string): string =>
  raw.replace(/^\/+|\/+$/g, '').replace(/\/+/g, '/');

export const listFolder = (db: DatabaseSync, rawPath: string): FolderListing => {
  const path = normalize(rawPath);
  const prefix = path === '' ? '' : `${path}/`;
  const escaped = escapeLike(prefix);

  // Direct children: files matching `<prefix>X` where X has no further slash.
  // Subfolders: files matching `<prefix>X/...` — the X segment is the subfolder.
  // Two passes over the prefix slice; the records table is small enough
  // (~1K rows) that this is microseconds.
  const rows = db
    .prepare(
      `SELECT file_path, title, type, status, updated
         FROM records
        WHERE file_path LIKE ? ESCAPE '\\'
        ORDER BY file_path`
    )
    .all(`${escaped}%`) as unknown[] as RecordRow[];

  const files: FolderFile[] = [];
  const subfolderSet = new Set<string>();
  for (const r of rows) {
    const tail = r.file_path.slice(prefix.length);
    const slashIdx = tail.indexOf('/');
    if (slashIdx === -1) {
      files.push({
        path: r.file_path,
        title: r.title,
        type: r.type,
        status: r.status,
        updated: r.updated
      });
    } else {
      subfolderSet.add(tail.slice(0, slashIdx));
    }
  }

  const subfolders = [...subfolderSet].sort();
  files.sort((a, b) => b.updated.localeCompare(a.updated));
  return {path, subfolders, files};
};
