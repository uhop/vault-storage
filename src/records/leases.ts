import type {DatabaseSync} from 'node:sqlite';

// Repo-lease registry (agent-coordination design, D21/D23) — the sibling of
// claims.ts, generalized: one row per resource, atomic claim with a 409-style
// conflict, TTL + lazy expiry. Precedence lattice: human > cwd agent > side
// agent — cwd preempts an agent-held side lease, the operator preempts any
// agent, nothing preempts a human. Human leases never expire.

export const HOLDER_KINDS = ['agent', 'human'] as const;
export type HolderKind = (typeof HOLDER_KINDS)[number];

export const LEASE_PRIORITIES = ['cwd', 'side'] as const;
export type LeasePriority = (typeof LEASE_PRIORITIES)[number];

export const DEFAULT_LEASE_TTL_SECONDS = 4 * 3600; // hours, not minutes: a deploy must not expire a lease
export const MIN_LEASE_TTL_SECONDS = 60;
export const MAX_LEASE_TTL_SECONDS = 24 * 3600;

export interface Lease {
  resource: string;
  holder: string;
  holderKind: HolderKind;
  priority: LeasePriority | null;
  attestation: string | null;
  claimedAt: string;
  renewedAt: string;
  expiresAt: string | null;
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
  | {status: 'claimed' | 'renewed' | 'preempted'; lease: Lease}
  | {status: 'conflict'; current: Lease};

export type LeaseOpOutcome =
  | {status: 'ok'; lease: Lease}
  | {status: 'released'}
  | {status: 'not_found'}
  | {status: 'not_holder'; current: Lease};

interface LeaseRow {
  resource: string;
  holder: string;
  holder_kind: string;
  priority: string | null;
  attestation: string | null;
  claimed_at: string;
  renewed_at: string;
  expires_at: string | null;
}

const toLease = (row: LeaseRow): Lease => ({
  resource: row.resource,
  holder: row.holder,
  holderKind: row.holder_kind as HolderKind,
  priority: row.priority as LeasePriority | null,
  attestation: row.attestation,
  claimedAt: row.claimed_at,
  renewedAt: row.renewed_at,
  expiresAt: row.expires_at
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
  now?: string;
}

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
    for (const row of expired) {
      this.#db.prepare('DELETE FROM leases WHERE resource = ?').run(row.resource);
      this.#logEvent(at, row.resource, 'expired', row.holder, null);
    }
    return expired.length;
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
   * Atomic claim. Re-claiming a held resource is a renew (idempotent — safe
   * retry after an ambiguous network failure). Preemption needs no consent:
   * the incumbent discovers demotion at its next verify.
   */
  claim(req: ClaimRequest): ClaimOutcome {
    const now = req.now ?? new Date().toISOString();
    this.expireLazy(now);
    const current = this.get(req.resource, now);

    if (current === null) {
      const lease = this.#write(req, now, now);
      this.#logEvent(now, req.resource, 'claimed', req.holder, this.#detail(req));
      return {status: 'claimed', lease};
    }

    if (current.holder === req.holder) {
      const lease = this.#write(req, current.claimedAt, now);
      this.#logEvent(now, req.resource, 'renewed', req.holder, null);
      return {status: 'renewed', lease};
    }

    if (this.#mayPreempt(req, current)) {
      const lease = this.#write(req, now, now);
      this.#logEvent(
        now,
        req.resource,
        'preempted',
        req.holder,
        JSON.stringify({prior_holder: current.holder, prior_kind: current.holderKind})
      );
      return {status: 'preempted', lease};
    }

    return {status: 'conflict', current};
  }

  renew(resource: string, holder: string, ttlSeconds?: number, now?: string): LeaseOpOutcome {
    const at = now ?? new Date().toISOString();
    const current = this.get(resource, at);
    if (current === null) return {status: 'not_found'};
    if (current.holder !== holder) return {status: 'not_holder', current};
    const expires = current.holderKind === 'human' ? null : this.#expiry(at, ttlSeconds);
    this.#db
      .prepare('UPDATE leases SET renewed_at = ?, expires_at = ? WHERE resource = ?')
      .run(at, expires, resource);
    this.#logEvent(at, resource, 'renewed', holder, null);
    const renewed = this.get(resource, at);
    return renewed ? {status: 'ok', lease: renewed} : {status: 'not_found'};
  }

  /** `force` is the operator's UI hatch; a normal release requires the holder to match. */
  release(resource: string, holder: string, force = false, now?: string): LeaseOpOutcome {
    const at = now ?? new Date().toISOString();
    const current = this.get(resource, at);
    if (current === null) return {status: 'not_found'};
    if (!force && current.holder !== holder) return {status: 'not_holder', current};
    this.#db.prepare('DELETE FROM leases WHERE resource = ?').run(resource);
    this.#logEvent(
      at,
      resource,
      'released',
      holder,
      force && current.holder !== holder ? JSON.stringify({forced_from: current.holder}) : null
    );
    return {status: 'released'};
  }

  /**
   * Atomic reassignment by the current holder (D23) — release-then-claim has
   * a snipe window between the calls; this has none. Transfer-to-human is the
   * "please review and commit" case.
   */
  transfer(
    resource: string,
    holder: string,
    to: {holder: string; holderKind: HolderKind; priority?: LeasePriority; ttlSeconds?: number},
    now?: string
  ): LeaseOpOutcome {
    const at = now ?? new Date().toISOString();
    const current = this.get(resource, at);
    if (current === null) return {status: 'not_found'};
    if (current.holder !== holder) return {status: 'not_holder', current};
    const human = to.holderKind === 'human';
    this.#db
      .prepare(
        `UPDATE leases
            SET holder = ?, holder_kind = ?, priority = ?, attestation = NULL,
                claimed_at = ?, renewed_at = ?, expires_at = ?
          WHERE resource = ?`
      )
      .run(
        to.holder,
        to.holderKind,
        human ? null : (to.priority ?? 'side'),
        at,
        at,
        human ? null : this.#expiry(at, to.ttlSeconds),
        resource
      );
    this.#logEvent(at, resource, 'transferred', holder, JSON.stringify({to: to.holder}));
    const lease = this.get(resource, at);
    return lease ? {status: 'ok', lease} : {status: 'not_found'};
  }

  events(resource?: string, limit = 100): LeaseEvent[] {
    const rows = (resource === undefined
      ? this.#db.prepare('SELECT * FROM lease_events ORDER BY seq DESC LIMIT ?').all(limit)
      : this.#db
          .prepare('SELECT * FROM lease_events WHERE resource = ? ORDER BY seq DESC LIMIT ?')
          .all(resource, limit)) as unknown[] as LeaseEvent[];
    return rows;
  }

  #mayPreempt(req: ClaimRequest, current: Lease): boolean {
    if (current.holderKind === 'human') return false; // nothing preempts the operator
    if (req.holderKind === 'human') return true; // the operator preempts any agent
    return req.priority === 'cwd' && current.priority === 'side';
  }

  #expiry(now: string, ttlSeconds?: number): string {
    const ttl = ttlSeconds ?? DEFAULT_LEASE_TTL_SECONDS;
    return new Date(Date.parse(now) + ttl * 1000).toISOString();
  }

  #write(req: ClaimRequest, claimedAt: string, now: string): Lease {
    const human = req.holderKind === 'human';
    this.#db
      .prepare(
        `INSERT INTO leases (resource, holder, holder_kind, priority, attestation, claimed_at, renewed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(resource) DO UPDATE SET
           holder = excluded.holder, holder_kind = excluded.holder_kind,
           priority = excluded.priority, attestation = excluded.attestation,
           claimed_at = excluded.claimed_at, renewed_at = excluded.renewed_at,
           expires_at = excluded.expires_at`
      )
      .run(
        req.resource,
        req.holder,
        req.holderKind,
        human ? null : (req.priority ?? 'side'),
        req.attestation ?? null,
        claimedAt,
        now,
        human ? null : this.#expiry(now, req.ttlSeconds)
      );
    const lease = this.get(req.resource, now);
    if (!lease) throw new Error(`lease write for ${req.resource} did not land`);
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
