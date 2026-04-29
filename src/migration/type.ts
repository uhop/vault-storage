// Migration: legacy type → closed-enum type. Most legacy values are already
// in the closed list (permanent, project, log, state, meta, index, fleeting);
// the two collapses are decision → design and learning → research per
// design/closed-enums.md § Decision: `decision` and `learning` collapsed.

import {RECORD_TYPES, type RecordType} from '../records/types.ts';

const TYPE_REMAP: Record<string, RecordType> = {
  decision: 'design',
  decisions: 'design',
  learning: 'research',
  learnings: 'research'
};

const RECORD_TYPE_SET: ReadonlySet<string> = new Set(RECORD_TYPES);

/**
 * Remap a legacy frontmatter type. Returns the canonical value when the input
 * is either already a closed-enum value, or a known legacy alias. Returns null
 * for unknown / missing values — caller should fall back to path-based inference.
 */
export const remapType = (raw: unknown): RecordType | null => {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  if (RECORD_TYPE_SET.has(trimmed)) return trimmed as RecordType;
  return TYPE_REMAP[trimmed] ?? null;
};
