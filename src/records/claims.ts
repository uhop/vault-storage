import type {DatabaseSync} from 'node:sqlite';

/**
 * Lazily revert expired claims to `pending`, clearing the claim columns.
 * Called at suggestion read/mutate entry points instead of a background job —
 * a crashed holder's batch resurfaces on the next suggestions touch. Returns
 * the number of claims reverted.
 */
export const revertExpiredClaims = (db: DatabaseSync, now?: string): number =>
  Number(
    db
      .prepare(
        `UPDATE suggestions
            SET status = 'pending', claimed_by = NULL, claimed_at = NULL, claim_expires = NULL
          WHERE status = 'claimed' AND claim_expires < ?`
      )
      .run(now ?? new Date().toISOString()).changes
  );
