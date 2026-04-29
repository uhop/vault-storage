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
  content_hash: string;
  archived_at: string | null;
  body?: string;
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
    decay_score: r.decayScore,
    content_hash: r.contentHash,
    archived_at: r.archivedAt
  };
  if (opts.includeBody !== false) out.body = r.body;
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
