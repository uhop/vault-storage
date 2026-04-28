// Typed shapes for the records / edges tables. Closed enums match the CHECK
// constraints in src/db/schema/0001_init.sql (sources of truth in
// design/closed-enums.md and design/edge-taxonomy.md).

export const RECORD_TYPES = [
  'idea',
  'design',
  'plan',
  'queue-item',
  'research',
  'bug-report',
  'project',
  'permanent',
  'log',
  'query',
  'fleeting',
  'state',
  'meta',
  'index'
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export const RECORD_STATUSES = ['active', 'draft', 'done', 'superseded', 'archived'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

export const EDGE_TYPES = [
  'supersedes',
  'revises',
  'derived-from',
  'caused-by',
  'fixed-by',
  'rejected-because',
  'cites',
  'applies-to',
  'contradicts',
  'related-to'
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export interface Record {
  recordId: string;
  filePath: string;
  parentPath: string | null;
  sequenceKey: number | null;
  type: RecordType;
  body: string;
  contentHash: string;
  /** ISO 8601 string. */
  created: string;
  /** ISO 8601 string. */
  updated: string;
  lastReferenced: string | null;
  decayScore: number;
  status: RecordStatus;
  priority: number;
  archivedAt: string | null;
}

export interface Edge {
  fromId: string;
  toId: string;
  type: EdgeType;
  weight: number;
  note: string | null;
  /** ISO 8601 string. */
  created: string;
}
