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
 * `agent.complexity` — the enrichment block's structural label (design
 * agent-frontmatter-enrichment § Field schema; closed-enums.md § agent.complexity).
 * A shape hint for the chunker and the review skills, never a difficulty
 * grade. Validated at the API write boundary (writer.ts), not by a CHECK:
 * the block lives in frontmatter only. Normalized fleet-wide 2026-09-06.
 */
export const AGENT_COMPLEXITY = [
  'prose',
  'code-heavy',
  'tabular',
  'mixed',
  'hub',
  'log-entry'
] as const;
export type AgentComplexity = (typeof AGENT_COMPLEXITY)[number];

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

/**
 * How a suggestion's finding was produced (`payload.evidence.source`).
 * `asserted` is true only for a fact read from stored data — a stale hash, an
 * unknown tag on frontmatter, an unreviewed link — never for a similarity
 * threshold or an agent's judgement: the ambiguity resolved to produce those
 * is the ambiguity a reader cannot resolve reliably.
 */
export const EVIDENCE_SOURCES = ['vector', 'lexical', 'agent', 'metric', 'structural'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];
export interface Evidence {
  source: EvidenceSource;
  asserted: boolean;
}
const EVIDENCE_SOURCE_SET: ReadonlySet<string> = new Set(EVIDENCE_SOURCES);
export const isEvidence = (value: unknown): value is Evidence =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  EVIDENCE_SOURCE_SET.has((value as {source?: unknown}).source as string) &&
  typeof (value as {asserted?: unknown}).asserted === 'boolean';

export const EDGE_TYPES = [
  'supersedes',
  'revises',
  'derived-from',
  'cites',
  'applies-to',
  'contradicts',
  'related-to'
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

/**
 * Pre-canonicalization aliases for *declared* edge types — FM `edges:` map
 * values and `edge_type` suggestion accepts. Notation only, never stored:
 * each normalizes to a canonical type with the edge direction flipped, per
 * edge-taxonomy's ruling that inverse relations are a direction, not a
 * second type. `basis-for` declared in A about B lands as B → derived-from → A
 * (the "generalized / promoted to [[topic]]" idiom, where the origin note
 * records where its material went).
 */
export interface EdgeTypeAlias {
  type: EdgeType;
  inverse: boolean;
  /** Written into the edge's note when the alias is applied. */
  note?: string;
  /** A name the vocabulary dropped (D94): accepted so old maps still resolve, never advertised. */
  legacy?: boolean;
}

export const EDGE_TYPE_ALIASES: Readonly<Record<string, EdgeTypeAlias>> = {
  'basis-for': {type: 'derived-from', inverse: true},
  // The 2026-09-28 revision (D94) dropped the three decision-rationale types:
  // five months produced 32 edges and no consumer. Declared, they land as cites
  // with the declared name in the note.
  'caused-by': {type: 'cites', inverse: false, note: 'declared as caused-by', legacy: true},
  'fixed-by': {type: 'cites', inverse: false, note: 'declared as fixed-by', legacy: true},
  'rejected-because': {
    type: 'cites',
    inverse: false,
    note: 'declared as rejected-because',
    legacy: true
  }
};

/** What an FM `edges:` map or `agent.edge_classifications` may declare, as advertised. */
export const DECLARED_EDGE_TYPES: readonly string[] = [
  ...EDGE_TYPES,
  ...Object.entries(EDGE_TYPE_ALIASES)
    .filter(([, a]) => !a.legacy)
    .map(([name]) => name)
];

/** Every declaration the importer and the writer accept: the advertised set plus the legacy names. */
export const ACCEPTED_EDGE_DECLARATIONS: readonly string[] = [
  ...EDGE_TYPES,
  ...Object.keys(EDGE_TYPE_ALIASES)
];

export interface VaultRecord {
  recordId: string;
  filePath: string;
  parentPath: string | null;
  sequenceKey: number | null;
  type: RecordType;
  body: string;
  /**
   * Embedding-input hash: `embedInputHash(body, agentSummary)`. Drives
   * chunk-set invalidation. Equals `bodyHash` when no summary is set.
   */
  contentHash: string;
  /**
   * sha256 of body alone. The clean body-vs-body comparand for
   * `agent.derived_from_hash` staleness checks and the `body_hash` wire
   * field; stays meaningful after a summary is mixed into `contentHash`.
   */
  bodyHash: string;
  /** Title from frontmatter; null when the source had no `title:` key. */
  title: string | null;
  /** ISO 8601 string. */
  created: string;
  /** ISO 8601 string. */
  updated: string;
  /**
   * Full ISO-8601 timestamp the repository upsert DB-stamps on every
   * write/import (schema 0012) — callers never supply it (the SQL overrides
   * any value), so it's optional on construction and only populated on read.
   * Unlike date-only `updated` (mirrors the FM field), it carries sub-day
   * precision for true recency ordering; null for rows not re-imported since
   * 0012 (forward-only, never backfilled).
   */
  modifiedAt?: string | null;
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
