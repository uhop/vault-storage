// Frontmatter bootstrap for files imported without YAML frontmatter (the 13
// archived `raw/*.md` notes per the audit). Per design constraint C12.1:
//   title  := first H1 / filename
//   tags   := empty (file a `tag_suggestion` later)
//   status := 'active'
//   type   := folder default (handled separately by typeFromPath)
//   created/updated := today (ISO date)
//
// This produces the *minimum* frontmatter the importer needs; richer fields
// (e.g., `related:`) are author-side and stay empty until the user adds them.

import {basename} from 'node:path';
import type {RecordStatus, RecordType} from '../records/types.ts';
import {DEFAULT_STATUS} from './status.ts';

export interface BackfilledFrontmatter {
  title: string;
  tags: string[];
  status: RecordStatus;
  type: RecordType;
  created: string;
  updated: string;
}

const H1 = /^#\s+(.+?)\s*$/m;

const titleFromBody = (body: string, fallback: string): string => {
  const m = H1.exec(body);
  if (m && m[1]) return m[1];
  return fallback;
};

const filenameToTitle = (filename: string): string => {
  const stem = basename(filename, '.md');
  return stem.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
};

/** Generate minimum frontmatter for a body that lacks any. */
export const backfillFrontmatter = (
  filename: string,
  body: string,
  inferredType: RecordType,
  isoDate: string
): BackfilledFrontmatter => ({
  title: titleFromBody(body, filenameToTitle(filename)),
  tags: [],
  status: DEFAULT_STATUS,
  type: inferredType,
  created: isoDate,
  updated: isoDate
});
