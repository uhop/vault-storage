import {randomUUID} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';

// Repo-lease registry (agent-coordination design, D21/D23) — the sibling of
// claims.ts, generalized: one row per resource, atomic claim with a 409-style
// conflict, TTL + lazy expiry. Precedence lattice: human > cwd agent > side
// agent — cwd preempts an agent-held side lease, and a cwd lease unrenewed
// for STALE_CWD_LEASE_SECONDS; the operator preempts any agent, nothing
// preempts a human. Human leases never expire.
//
// An agent claim issues a token (D67); renew, release, and transfer present
// it, so two claims under one holder name never share a fence. A human lease
// carries none: the operator's name is unique, and `force` is the hatch.

export const HOLDER_KINDS = ['agent', 'human'] as const;
export type HolderKind = (typeof HOLDER_KINDS)[number];

export const LEASE_PRIORITIES = ['cwd', 'side'] as const;
export type LeasePriority = (typeof LEASE_PRIORITIES)[number];

export const DEFAULT_LEASE_TTL_SECONDS = 4 * 3600; // hours, not minutes: a deploy must not expire a lease
export const MIN_LEASE_TTL_SECONDS = 60;
export const MAX_LEASE_TTL_SECONDS = 24 * 3600;
/** Ruled 2026-09-19: past the gate's 15 min renew throttle, short of the 4 h TTL a dead session's lease used to hold. */
export const STALE_CWD_LEASE_SECONDS = 3600;
/** A write fenced on the row as read re-decides on a miss; a miss needs a second writer process (D69). */
const FENCE_ATTEMPTS = 3;

const lostRaces = (op: string, resource: string): Error =>
  new Error(`lease ${op} for ${resource} lost ${FENCE_ATTEMPTS} races with another writer`);

export interface Lease {
  resource: string;
  holder: string;
  holderKind: HolderKind;
  priority: LeasePriority | null;
  attestation: string | null;
  claimedAt: string;
  renewedAt: string;
  expiresAt: string | null;
  /** Returned to the claimer only; never serialized in a listing. Null for a human lease. */
  claimToken: string | null;
}

export interface LeaseEvent {
  seq: number;
  at: string;
  resource: string;
  event: 'claimed' | 'renewed' | 'preempted' | 'expired' | 'released' | 'transferred';
  holder: string | null;
  detail: string | null;
}

export type ClaimOutcome =
  | {status: 'claimed' | 'renewed'; lease: Lease}
  | {status: 'preempted'; lease: Lease; prior: Lease}
  | {status: 'conflict'; current: Lease}
  | {status: 'token_mismatch'; current: Lease};

export type LeaseOpOutcome =
  | {status: 'ok'; lease: Lease}
  | {status: 'released'}
  | {status: 'not_found'}
  | {status: 'not_holder'; current: Lease}
  | {status: 'token_mismatch'; current: Lease};

interface LeaseRow {
  resource: string;
  holder: string;
  holder_kind: string;
  priority: string | null;
  attestation: string | null;
  claimed_at: string;
  renewed_at: string;
  expires_at: string | null;
  claim_token: string | null;
}

const toLease = (row: LeaseRow): Lease => ({
  resource: row.resource,
  holder: row.holder,
  holderKind: row.holder_kind as HolderKind,
  priority: row.priority as LeasePriority | null,
  attestation: row.attestation,
  claimedAt: row.claimed_at,
  renewedAt: row.renewed_at,
  expiresAt: row.expires_at,
  claimToken: row.claim_token
});

export interface ClaimRequest {
  resource: string;
  holder: string;
  holderKind: HolderKind;
  /** Required for agents, forbidden for humans (schema CHECK). */
  priority?: LeasePriority;
  /** Side-claim clean-tree evidence, e.g. "clean at abc1234" (D23; client-side check). */
  attestation?: string;
  ttlSeconds?: number;
  /** The token of the caller's live claim; a re-claim under the same name renews only with it. */
  claimToken?: string;
  now?: string;
}

/** Whether a caller may act on `current`: the holder by name for a human, by token for an agent. */
const standing = (
  current: Lease,
  holder: string,
  token: string | null
): 'ok' | 'not_holder' | 'token_mismatch' => {
  if (current.holder !== holder) return 'not_holder';
  if (current.holderKind === 'human') return 'ok';
  return token !== null && token === current.claimToken ? 'ok' : 'token_mismatch';
};

export class LeasesRepository {
  #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /** Leases are a clean slate on server start and stay gone — a lock has no artifact (D21). */
  clearAll(): void {
    this.#db.exec('DELETE FROM leases; DELETE FROM lease_events;');
  }

  /**
   * Lazily drop expired leases, logging an `expired` event per drop — called
   * at every entry point instead of a background job, like claims.ts. Human
   * leases have no expiry and never match.
   */
  expireLazy(now?: string): number {
    const at = now ?? new Date().toISOString();
    const expired = this.#db
      .prepare('SELECT * FROM leases WHERE expires_at IS NOT NULL AND expires_at < ?')
      .all(at) as unknown[] as LeaseRow[];
    let dropped = 0;
    for (const row of expired) {
      // A renew in the gap moves expires_at: skip, the next read sweeps again.
      const changed = this.#db
        .prepare(
          `DELETE FROM leases
            WHERE resource = ? AND holder = ? AND claim_token IS ? AND expires_at = ?`
        )
        .run(row.resource, row.holder, row.claim_token, row.expires_at).changes;
      if (changed === 0) continue;
      this.#logEvent(at, row.resource, 'expired', row.holder, null);
      ++dropped;
    }
    return dropped;
  }

  list(now?: string): Lease[] {
    this.expireLazy(now);
    const rows = this.#db
      .prepare('SELECT * FROM leases ORDER BY resource')
      .all() as unknown[] as LeaseRow[];
    return rows.map(toLease);
  }

  get(resource: string, now?: string): Lease | null {
    this.expireLazy(now);
    const row = this.#db.prepare('SELECT * FROM leases WHERE resource = ?').get(resource) as
      LeaseRow | undefined;
    return row ? toLease(row) : null;
  }

  /**
   * Atomic claim. Re-claiming a held resource with its token is a renew
   * (idempotent — safe retry after an ambiguous network failure); the same
   * name without it is `token_mismatch`. Preemption needs no consent: the
   * incumbent discovers demotion at its next verify.
   */
  claim(req: ClaimRequest): ClaimOutcome {
    const now = req.now ?? new Date().toISOString();
    for (let attempt = 0; attempt < FENCE_ATTEMPTS; ++attempt) {
      const current = this.get(req.resource, now);

      if (current === null) {
        const lease = this.#insert(req, now);
        if (lease === null) continue;
        this.#logEvent(now, req.resource, 'claimed', req.holder, this.#detail(req));
        return {status: 'claimed', lease};
      }

      if (current.holder === req.holder) {
        if (standing(current, req.holder, req.claimToken ?? null) !== 'ok') {
          return {status: 'token_mismatch', current};
        }
        const lease = this.#replace(req, current, current.claimedAt, now, current.claimToken);
        if (lease === null) continue;
        this.#logEvent(now, req.resource, 'renewed', req.holder, null);
        return {status: 'renewed', lease};
      }

      if (!this.#mayPreempt(req, current, now)) return {status: 'conflict', current};

      const lease = this.#replace(req, current, now, now);
      if (lease === null) continue;
      const stale = req.holderKind === 'agent' && current.priority === 'cwd';
      this.#logEvent(
        now,
        req.resource,
        'preempted',
        req.holder,
        JSON.stringify({
          prior_holder: current.holder,
          prior_kind: current.holderKind,
          ...(stale ? {unrenewed_since: current.renewedAt} : {})
        })
      );
      return {status: 'preempted', lease, prior: current};
    }
    throw lostRaces('claim', req.resource);
  }

  renew(
    resource: string,
    holder: string,
    token: string | null,
    ttlSeconds?: number,
    now?: string
  ): LeaseOpOutcome {
    const at = now ?? new Date().toISOString();
    for (let attempt = 0; attempt < FENCE_ATTEMPTS; ++attempt) {
      const current = this.get(resource, at);
      if (current === null) return {status: 'not_found'};
      const stand = standing(current, holder, token);
      if (stand !== 'ok') return {status: stand, current};
      const expires = current.holderKind === 'human' ? null : this.#expiry(at, ttlSeconds);
      const changed = this.#db
        .prepare(
          `UPDATE leases SET renewed_at = ?, expires_at = ?
            WHERE resource = ? AND holder = ? AND claim_token IS ?`
        )
        .run(at, expires, resource, current.holder, current.claimToken).changes;
      if (changed === 0) continue;
      this.#logEvent(at, resource, 'renewed', holder, null);
      const renewed = this.get(resource, at);
      return renewed ? {status: 'ok', lease: renewed} : {status: 'not_found'};
    }
    throw lostRaces('renew', resource);
  }

  /** `force` is the operator's UI hatch; a normal release requires the holder and its token. */
  release(
    resource: string,
    holder: string,
    token: string | null,
    force = false,
    now?: string
  ): LeaseOpOutcome {
    const at = now ?? new Date().toISOString();
    for (let attempt = 0; attempt < FENCE_ATTEMPTS; ++attempt) {
      const current = this.get(resource, at);
      if (current === null) return {status: 'not_found'};
      if (!force) {
        const stand = standing(current, holder, token);
        if (stand !== 'ok') return {status: stand, current};
      }
      const changed = this.#db
        .prepare('DELETE FROM leases WHERE resource = ? AND holder = ? AND claim_token IS ?')
        .run(resource, current.holder, current.claimToken).changes;
      if (changed === 0) continue;
      this.#logEvent(
        at,
        resource,
        'released',
        holder,
        force && current.holder !== holder ? JSON.stringify({forced_from: current.holder}) : null
      );
      return {status: 'released'};
    }
    throw lostRaces('release', resource);
  }

  /**
   * Atomic reassignment by the current holder (D23) — release-then-claim has
   * a snipe window between the calls; this has none. Transfer-to-human is the
   * "please review and commit" case. An agent recipient gets a fresh token,
   * returned to the caller to hand over.
   */
  transfer(
    resource: string,
    holder: string,
    token: string | null,
    to: {holder: string; holderKind: HolderKind; priority?: LeasePriority; ttlSeconds?: number},
    now?: string
  ): LeaseOpOutcome {
    const at = now ?? new Date().toISOString();
    const human = to.holderKind === 'human';
    for (let attempt = 0; attempt < FENCE_ATTEMPTS; ++attempt) {
      const current = this.get(resource, at);
      if (current === null) return {status: 'not_found'};
      const stand = standing(current, holder, token);
      if (stand !== 'ok') return {status: stand, current};
      const changed = this.#db
        .prepare(
          `UPDATE leases
              SET holder = ?, holder_kind = ?, priority = ?, attestation = NULL,
                  claimed_at = ?, renewed_at = ?, expires_at = ?, claim_token = ?
            WHERE resource = ? AND holder = ? AND claim_token IS ?`
        )
        .run(
          to.holder,
          to.holderKind,
          human ? null : (to.priority ?? 'side'),
          at,
          at,
          human ? null : this.#expiry(at, to.ttlSeconds),
          human ? null : randomUUID(),
          resource,
          current.holder,
          current.claimToken
        ).changes;
      if (changed === 0) continue;
      this.#logEvent(at, resource, 'transferred', holder, JSON.stringify({to: to.holder}));
      const lease = this.get(resource, at);
      return lease ? {status: 'ok', lease} : {status: 'not_found'};
    }
    throw lostRaces('transfer', resource);
  }

  events(resource?: string, limit = 100): LeaseEvent[] {
    const rows = (resource === undefined
      ? this.#db.prepare('SELECT * FROM lease_events ORDER BY seq DESC LIMIT ?').all(limit)
      : this.#db
          .prepare('SELECT * FROM lease_events WHERE resource = ? ORDER BY seq DESC LIMIT ?')
          .all(resource, limit)) as unknown[] as LeaseEvent[];
    return rows;
  }

  #mayPreempt(req: ClaimRequest, current: Lease, now: string): boolean {
    if (current.holderKind === 'human') return false; // nothing preempts the operator
    if (req.holderKind === 'human') return true; // the operator preempts any agent
    if (req.priority !== 'cwd') return false;
    return (
      current.priority === 'side' ||
      Date.parse(now) - Date.parse(current.renewedAt) > STALE_CWD_LEASE_SECONDS * 1000
    );
  }

  #expiry(now: string, ttlSeconds?: number): string {
    const ttl = ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
    return new Date(Date.parse(now) + ttl * 1000).toISOString();
  }

  /** Null when another writer created the row first. */
  #insert(req: ClaimRequest, now: string): Lease | null {
    const changed = this.#db
      .prepare(
        `INSERT INTO leases (resource, holder, holder_kind, priority, attestation, claimed_at, renewed_at, expires_at, claim_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(resource) DO NOTHING`
      )
      .run(req.resource, ...this.#values(req, now, now)).changes;
    return changed === 0 ? null : this.#landed(req.resource, now);
  }

  /** Overwrites `current` as read; null when another writer changed it first. */
  #replace(
    req: ClaimRequest,
    current: Lease,
    claimedAt: string,
    now: string,
    token?: string | null
  ): Lease | null {
    const changed = this.#db
      .prepare(
        `UPDATE leases
            SET holder = ?, holder_kind = ?, priority = ?, attestation = ?,
                claimed_at = ?, renewed_at = ?, expires_at = ?, claim_token = ?
          WHERE resource = ? AND holder = ? AND claim_token IS ?`
      )
      .run(
        ...this.#values(req, claimedAt, now, token),
        req.resource,
        current.holder,
        current.claimToken
      ).changes;
    return changed === 0 ? null : this.#landed(req.resource, now);
  }

  /** `token` keeps a renewed claim's token; a new claim gets a fresh one (none for a human). */
  #values(req: ClaimRequest, claimedAt: string, now: string, token?: string | null) {
    const human = req.holderKind === 'human';
    return [
      req.holder,
      req.holderKind,
      human ? null : (req.priority ?? 'side'),
      req.attestation ?? null,
      claimedAt,
      now,
      human ? null : this.#expiry(now, req.ttlSeconds),
      human ? null : (token ?? randomUUID())
    ];
  }

  #landed(resource: string, now: string): Lease {
    const lease = this.get(resource, now);
    if (!lease) throw new Error(`lease write for ${resource} did not land`);
    return lease;
  }

  #detail(req: ClaimRequest): string | null {
    return req.attestation ? JSON.stringify({attestation: req.attestation}) : null;
  }

  #logEvent(
    at: string,
    resource: string,
    event: LeaseEvent['event'],
    holder: string | null,
    detail: string | null
  ): void {
    this.#db
      .prepare(
        'INSERT INTO lease_events (at, resource, event, holder, detail) VALUES (?, ?, ?, ?, ?)'
      )
      .run(at, resource, event, holder, detail);
  }
}
