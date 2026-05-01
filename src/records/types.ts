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

/**
 * Pre-canonicalization aliases for `status`. Per closed-enums design the
 * 14 legacy values collapse into 5; the importer maps known aliases
 * explicitly so legacy FM values keep their intent (e.g. `completed`
 * stays a completion record, not silently coerced to `active`). Unknown
 * values still fall back to the default.
 */
export const STATUS_ALIASES: Readonly<Record<string, RecordStatus>> = {
  completed: 'done',
  shipped: 'done',
  processed: 'done',
  'done-round-1': 'done',
  'in-progress': 'active',
  paused: 'active',
  idea: 'draft',
  stub: 'draft',
  design: 'draft',
  archive: 'archived'
};

/**
 * Pre-canonicalization aliases for `priority`. Per closed-enums design
 * priority is open-ended integer; these named aliases are sugar on FM
 * input. The integer is canonical (stored as-is, no normalization on
 * read).
 */
export const PRIORITY_ALIASES: Readonly<Record<string, number>> = {
  low: -1,
  normal: 0,
  high: 1,
  critical: 2
};

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

export interface VaultRecord {
  recordId: string;
  filePath: string;
  parentPath: string | null;
  sequenceKey: number | null;
  type: RecordType;
  body: string;
  contentHash: string;
  /** Title from frontmatter; null when the source had no `title:` key. */
  title: string | null;
  /** ISO 8601 string. */
  created: string;
  /** ISO 8601 string. */
  updated: string;
  lastReferenced: string | null;
  decayScore: number;
  status: RecordStatus;
  priority: number;
  archivedAt: string | null;
  /**
   * Agent-derived summary from the source FM `agent.summary` (per design
   * doc agent-frontmatter-enrichment). Prepended to each chunk at embed time
   * as a HyDE-style retrieval anchor. Null when the source has no `agent:`
   * block — chunker falls back to body-only.
   */
  agentSummary: string | null;
  /**
   * Body content_hash recorded by the LLM when it generated `agent.summary`.
   * Compare to current `contentHash` to detect staleness. Null when no
   * `agent:` block exists.
   */
  agentDerivedFromHash: string | null;
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
