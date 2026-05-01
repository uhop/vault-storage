// Decay scoring per the storage-alternatives design § Decay and aging.
//
// Score is computed lazily from `last_referenced` (set on every single-
// record read; see RecordsRepository.bumpLastReferenced) — the column
// records.decay_score is vestigial and unused at runtime. Lazy compute
// avoids the cost of touching every record on every clock tick and
// keeps the math debuggable: identical inputs → identical outputs.
//
// Math: `score = exp(-lambda * days_since_anchor)` where `anchor` is
// `last_referenced` if present, otherwise `created` (a freshly-imported
// record starts at score 1.0 and decays from its creation date).
//
// `lambda` defaults to 0.005/day → half-life ≈ 138 days, score ~0.16
// after a year. Calibrated for the use case "logs decay aggressively,
// design notes don't" — the per-type retention scan layers ON TOP of
// this score, applying type-specific cliffs (logs > 90d → archive
// candidate even though their score is still ~0.64).

import type {VaultRecord} from './types.ts';

/** Default decay rate, tuned for personal-vault scale. Per-day. */
export const DEFAULT_DECAY_LAMBDA = 0.005;

const MS_PER_DAY = 86_400_000;

const parseISO = (s: string): number => {
  const t = Date.parse(s);
  // ISO 8601 dates without time-of-day (e.g. "2026-04-15" from FM)
  // parse to UTC midnight, which is what we want.
  return Number.isFinite(t) ? t : Date.now();
};

/**
 * Compute the lazy decay score for a record at instant `now`.
 *
 * - `last_referenced` is the freshness anchor. When present, the score
 *   counts time since the last single-record read.
 * - Falls back to `created` for never-read records, so a freshly-
 *   imported record starts at score 1.0.
 * - Returns 1.0 when the anchor is in the future (clock skew); 0 is the
 *   asymptote but never returned in finite time.
 */
export const computeDecayScore = (
  record: Pick<VaultRecord, 'lastReferenced' | 'created'>,
  now: Date = new Date(),
  lambda: number = DEFAULT_DECAY_LAMBDA
): number => {
  const anchor = record.lastReferenced ?? record.created;
  const anchorMs = parseISO(anchor);
  const days = (now.getTime() - anchorMs) / MS_PER_DAY;
  if (days <= 0) return 1;
  return Math.exp(-lambda * days);
};
