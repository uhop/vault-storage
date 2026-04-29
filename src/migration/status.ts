// Migration: legacy status (14 distinct values found in the live vault audit)
// → closed-enum status (5 values). Source of truth: design/closed-enums.md.

import type {RecordStatus} from '../records/types.ts';

const STATUS_REMAP: Record<string, RecordStatus> = {
  active: 'active',
  'in-progress': 'active',
  paused: 'active',
  done: 'done',
  completed: 'done',
  shipped: 'done',
  processed: 'done',
  'done-round-1': 'done',
  stub: 'draft',
  idea: 'draft',
  design: 'draft',
  superseded: 'superseded',
  archive: 'archived',
  archived: 'archived'
};

export const DEFAULT_STATUS: RecordStatus = 'active';

/** Map a raw frontmatter status to the closed-enum value. Unknown / missing → DEFAULT_STATUS. */
export const remapStatus = (raw: unknown): RecordStatus => {
  if (typeof raw !== 'string') return DEFAULT_STATUS;
  const trimmed = raw.trim().toLowerCase();
  return STATUS_REMAP[trimmed] ?? DEFAULT_STATUS;
};
