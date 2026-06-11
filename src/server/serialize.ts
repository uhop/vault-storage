import {computeDecayScore} from '../records/decay.ts';
import type {Edge, VaultRecord} from '../records/types.ts';

export interface JsonRecord {
  record_id: string;
  file_path: string;
  parent_path: string | null;
  sequence_key: number | null;
  type: string;
  status: string;
  priority: number;
  title: string | null;
  created: string;
  updated: string;
  last_referenced: string | null;
  decay_score: number;
  /**
   * Embedding-input hash. Drives chunk-set invalidation. Equals
   * `body_hash` for records without an `agent.summary`; differs once a
   * summary is mixed in (`embedInputHash(body, summary)`). Don't use this
   * to populate `agent.derived_from_hash` — use `body_hash` for that.
   */
  content_hash: string;
  /**
   * Pure body hash (`sha256(body)`). The value `/vault-enrich-all` writes
   * into `agent.derived_from_hash` so staleness detection sees a clean
   * body-vs-body comparison even after a summary is set. Persisted on the
   * record since schema 0011.
   */
  body_hash: string;
  archived_at: string | null;
  body?: string;
  /** Agent-derived summary (HyDE prefix). Only present when set. */
  agent_summary?: string;
  /** Body content_hash recorded at LLM derivation. Only present when set. */
  agent_derived_from_hash?: string;
}

export interface JsonEdge {
  from_id: string;
  to_id: string;
  type: string;
  weight: number;
  note: string | null;
  created: string;
}

export interface SerializeOptions {
  /** Include the `body` field in output. Default true. */
  includeBody?: boolean;
}

export const toJsonRecord = (r: VaultRecord, opts: SerializeOptions = {}): JsonRecord => {
  const out: JsonRecord = {
    record_id: r.recordId,
    file_path: r.filePath,
    parent_path: r.parentPath,
    sequence_key: r.sequenceKey,
    type: r.type,
    status: r.status,
    priority: r.priority,
    title: r.title,
    created: r.created,
    updated: r.updated,
    last_referenced: r.lastReferenced,
    decay_score: computeDecayScore(r),
    content_hash: r.contentHash,
    body_hash: r.bodyHash,
    archived_at: r.archivedAt
  };
  if (opts.includeBody !== false) out.body = r.body;
  if (r.agentSummary !== null) out.agent_summary = r.agentSummary;
  if (r.agentDerivedFromHash !== null) out.agent_derived_from_hash = r.agentDerivedFromHash;
  return out;
};

export const toJsonEdge = (e: Edge): JsonEdge => ({
  from_id: e.fromId,
  to_id: e.toId,
  type: e.type,
  weight: e.weight,
  note: e.note,
  created: e.created
});
