import type {DatabaseSync} from 'node:sqlite';
import {uuidv7} from '../util/uuid.ts';
import {
  HANDOFF_STATUSES,
  moveEntry,
  scanSpool,
  writeSidecar,
  removeEntry,
  type HandoffStatus,
  type SpoolEntry,
  type SpoolSidecar
} from './handoff-spool.ts';

// Handoff queue (agent-coordination design, leg 2) — the sibling of
// leases.ts, addressed to a *role* (`repo:<normalized-remote-url>`), never a
// session: work must survive its requester. The spool file is the source of
// truth; every mutation here updates the DB row and the sidecar together,
// and the whole table is rebuilt from the spool on server start.
// Claim machinery mirrors suggestions (`revertExpiredClaims`): a
// claimed-but-expired handoff lazily reverts to open, so a dead claimant
// never wedges work. Lifecycle (D23): open → claimed → done | rejected |
// returned → open (resubmission reuses the record — no new id).

export const HANDOFF_KINDS = [
  'review-branch',
  'apply-patch',
  'answer-question',
  'run-check'
] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];

/** `spool` is reserved in the schema for the leg-3 patch transport; the API accepts these two. */
export const HANDOFF_REF_TYPES = ['worktree', 'branch'] as const;
export type HandoffRefType = (typeof HANDOFF_REF_TYPES)[number];

export {HANDOFF_STATUSES, type HandoffStatus};

export const DEFAULT_CLAIM_TTL_SECONDS = 1800; // a review burst, not a lease: 30 min like suggestion claims
export const MIN_CLAIM_TTL_SECONDS = 60;
export const MAX_CLAIM_TTL_SECONDS = 86400;

export interface HandoffNote {
  author: string;
  at: string;
  text: string;
}

export interface Handoff {
  id: string;
  idempotencyKey: string;
  project: string;
  to: string;
  kind: HandoffKind;
  ref: {type: string; value: string} | null;
  from: {host: string; session: string; repo: string | null};
  body: string;
  status: HandoffStatus;
  created: string;
  updated: string;
  claimedBy: string | null;
  claimedAt: string | null;
  claimExpires: string | null;
  result: Record<string, unknown> | null;
  notes: HandoffNote[];
}

export interface HandoffEvent {
  seq: number;
  at: string;
  handoff_id: string;
  event:
    | 'created'
    | 'claimed'
    | 'claim_expired'
    | 'done'
    | 'rejected'
    | 'returned'
    | 'resubmitted'
    | 'note';
  actor: string | null;
  detail: string | null;
}

export interface HandoffCreate {
  idempotencyKey: string;
  project: string;
  to: string;
  kind: HandoffKind;
  ref?: {type: HandoffRefType; value: string};
  from: {host: string; session: string; repo?: string};
  body: string;
  now?: string;
}

export interface HandoffFilters {
  to?: string;
  project?: string;
  status?: HandoffStatus;
  kind?: HandoffKind;
}

export type CreateOutcome = {status: 'created' | 'existing'; handoff: Handoff};

export type ClaimHandoffOutcome =
  | {status: 'claimed' | 'renewed'; handoff: Handoff}
  | {status: 'not_found'}
  | {status: 'not_open'; current: Handoff}
  | {status: 'claimed_by_other'; current: Handoff};

export type ResolveOutcome =
  | {status: 'ok'; handoff: Handoff}
  | {status: 'not_found'}
  | {status: 'not_claimed'; current: Handoff}
  | {status: 'not_holder'; current: Handoff};

export type ResubmitOutcome =
  | {status: 'ok'; handoff: Handoff}
  | {status: 'not_found'}
  | {status: 'not_returned'; current: Handoff};

export type NoteOutcome =
  {status: 'ok'; handoff: Handoff} | {status: 'not_found'} | {status: 'resolved'; current: Handoff};

export interface RebuildReport {
  restored: number;
  reverted: number;
  /** done/rejected spool entries — resolved but not yet archived (crash window); the caller completes archival. */
  archivalPending: {id: string; project: string; status: HandoffStatus}[];
  skipped: string[];
}

interface HandoffRow {
  id: string;
  idempotency_key: string;
  project: string;
  to_role: string;
  kind: string;
  ref_type: string | null;
  ref_value: string | null;
  from_host: string;
  from_session: string;
  from_repo: string | null;
  body: string;
  status: string;
  created: string;
  updated: string;
  claimed_by: string | null;
  claimed_at: string | null;
  claim_expires: string | null;
  result: string | null;
  notes: string;
}

const toHandoff = (row: HandoffRow): Handoff => ({
  id: row.id,
  idempotencyKey: row.idempotency_key,
  project: row.project,
  to: row.to_role,
  kind: row.kind as HandoffKind,
  ref:
    row.ref_type !== null && row.ref_value !== null
      ? {type: row.ref_type, value: row.ref_value}
      : null,
  from: {host: row.from_host, session: row.from_session, repo: row.from_repo},
  body: row.body,
  status: row.status as HandoffStatus,
  created: row.created,
  updated: row.updated,
  claimedBy: row.claimed_by,
  claimedAt: row.claimed_at,
  claimExpires: row.claim_expires,
  result: row.result === null ? null : (JSON.parse(row.result) as Record<string, unknown>),
  notes: JSON.parse(row.notes) as HandoffNote[]
});

const toSidecar = (h: Handoff): SpoolSidecar => ({
  id: h.id,
  idempotency_key: h.idempotencyKey,
  project: h.project,
  to: h.to,
  kind: h.kind,
  ...(h.ref ? {ref: {type: h.ref.type, value: h.ref.value}} : {}),
  from: {
    host: h.from.host,
    session: h.from.session,
    ...(h.from.repo !== null ? {repo: h.from.repo} : {})
  },
  created: h.created,
  updated: h.updated,
  ...(h.claimedBy !== null ? {claimed_by: h.claimedBy} : {}),
  ...(h.claimedAt !== null ? {claimed_at: h.claimedAt} : {}),
  ...(h.claimExpires !== null ? {claim_expires: h.claimExpires} : {}),
  ...(h.result !== null ? {result: h.result} : {}),
  notes: h.notes
});

export class HandoffsRepository {
  #db: DatabaseSync;
  #vaultDataPath: string;

  constructor(db: DatabaseSync, vaultDataPath: string) {
    this.#db = db;
    this.#vaultDataPath = vaultDataPath;
  }

  clearAll(): void {
    this.#db.exec('DELETE FROM handoffs; DELETE FROM handoff_events;');
  }

  /**
   * Server-start recovery: clear the index and repopulate it from the spool
   * (files are truth). Directory decides status — stale claim fields from a
   * crash between rewrite and rename are dropped; expired claims revert to
   * open exactly as they would have lazily.
   */
  rebuild(now?: string): RebuildReport {
    const at = now ?? new Date().toISOString();
    this.clearAll();
    const {entries, skipped} = scanSpool(this.#vaultDataPath);
    const report: RebuildReport = {restored: 0, reverted: 0, archivalPending: [], skipped};
    for (const entry of entries) {
      const handoff = this.#fromSpool(entry);
      // A claimed entry reverts to open when its claim expired — or when its
      // claim fields are gone entirely (a crash between a resolve's content
      // rewrite and the status rename leaves exactly that; the verdict is
      // lost, the work is not — the claimant re-resolves).
      if (
        handoff.status === 'claimed' &&
        (handoff.claimExpires === null || handoff.claimExpires < at)
      ) {
        this.#revertClaim(handoff, at);
        ++report.reverted;
      } else {
        try {
          this.#insert(handoff);
        } catch (err) {
          report.skipped.push(
            `${entry.sidecar.project}/${entry.status}/${entry.sidecar.id}: ${(err as Error).message}`
          );
          continue;
        }
        if (handoff.status === 'done' || handoff.status === 'rejected') {
          report.archivalPending.push({
            id: handoff.id,
            project: handoff.project,
            status: handoff.status
          });
        }
      }
      ++report.restored;
    }
    return report;
  }

  /**
   * Lazily revert expired claims to open (DB + spool rename), logging a
   * `claim_expired` event per revert — called at every entry point instead
   * of a background job, like claims.ts. A dead claimant costs at most the
   * claim TTL, never a wedged handoff.
   */
  expireLazy(now?: string): number {
    const at = now ?? new Date().toISOString();
    const rows = this.#db
      .prepare(`SELECT * FROM handoffs WHERE status = 'claimed' AND claim_expires < ?`)
      .all(at) as unknown[] as HandoffRow[];
    for (const row of rows) this.#revertClaim(toHandoff(row), at);
    return rows.length;
  }

  /** Idempotent by key: a retry after an ambiguous failure returns the original. */
  create(req: HandoffCreate): CreateOutcome {
    const now = req.now ?? new Date().toISOString();
    const existing = this.#db
      .prepare('SELECT * FROM handoffs WHERE idempotency_key = ?')
      .get(req.idempotencyKey) as HandoffRow | undefined;
    if (existing) return {status: 'existing', handoff: toHandoff(existing)};

    const handoff: Handoff = {
      id: uuidv7(),
      idempotencyKey: req.idempotencyKey,
      project: req.project,
      to: req.to,
      kind: req.kind,
      ref: req.ref ?? null,
      from: {host: req.from.host, session: req.from.session, repo: req.from.repo ?? null},
      body: req.body,
      status: 'open',
      created: now,
      updated: now,
      claimedBy: null,
      claimedAt: null,
      claimExpires: null,
      result: null,
      notes: []
    };
    // Sidecar before row: files are truth, so a crash between the two loses
    // the index (rebuilt by scan on the next start), never the submission.
    writeSidecar(this.#vaultDataPath, this.#toSpool(handoff));
    this.#insert(handoff);
    this.#logEvent(
      now,
      handoff.id,
      'created',
      `${req.from.host}/${req.from.session}`,
      JSON.stringify({to: req.to, kind: req.kind})
    );
    return {status: 'created', handoff};
  }

  get(id: string, now?: string): Handoff | null {
    this.expireLazy(now);
    const row = this.#db.prepare('SELECT * FROM handoffs WHERE id = ?').get(id) as
      HandoffRow | undefined;
    return row ? toHandoff(row) : null;
  }

  list(filters: HandoffFilters, now?: string): Handoff[] {
    this.expireLazy(now);
    const clauses: string[] = [];
    const values: string[] = [];
    if (filters.to !== undefined) {
      clauses.push('to_role = ?');
      values.push(filters.to);
    }
    if (filters.project !== undefined) {
      clauses.push('project = ?');
      values.push(filters.project);
    }
    if (filters.status !== undefined) {
      clauses.push('status = ?');
      values.push(filters.status);
    }
    if (filters.kind !== undefined) {
      clauses.push('kind = ?');
      values.push(filters.kind);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.#db
      .prepare(`SELECT * FROM handoffs${where} ORDER BY created`)
      .all(...values) as unknown[] as HandoffRow[];
    return rows.map(toHandoff);
  }

  /** open → claimed; idempotent re-claim by the current claimant is a renew. */
  claim(id: string, holder: string, ttlSeconds?: number, now?: string): ClaimHandoffOutcome {
    const at = now ?? new Date().toISOString();
    const current = this.get(id, at);
    if (current === null) return {status: 'not_found'};

    if (current.status === 'claimed') {
      if (current.claimedBy !== holder) return {status: 'claimed_by_other', current};
      const renewed = this.#applyClaim(current, holder, ttlSeconds, at);
      this.#logEvent(at, id, 'claimed', holder, JSON.stringify({renewed: true}));
      return {status: 'renewed', handoff: renewed};
    }
    if (current.status !== 'open') return {status: 'not_open', current};

    const claimed = this.#applyClaim(current, holder, ttlSeconds, at);
    moveEntry(this.#vaultDataPath, claimed.project, id, 'open', 'claimed');
    this.#logEvent(at, id, 'claimed', holder, null);
    return {status: 'claimed', handoff: claimed};
  }

  /**
   * The review loop's verdict (D23): done (merged) and rejected are terminal
   * — the caller archives into vault-data and clears the spool entry;
   * returned reopens the same handoff for rework with the critique appended
   * to notes.
   */
  resolve(
    id: string,
    holder: string,
    resolution: 'done' | 'rejected' | 'returned',
    result?: Record<string, unknown>,
    note?: string,
    now?: string
  ): ResolveOutcome {
    const at = now ?? new Date().toISOString();
    const current = this.get(id, at);
    if (current === null) return {status: 'not_found'};
    if (current.status !== 'claimed') return {status: 'not_claimed', current};
    if (current.claimedBy !== holder) return {status: 'not_holder', current};

    const next: Handoff = {
      ...current,
      status: resolution === 'returned' ? 'returned' : resolution,
      updated: at,
      claimedBy: null,
      claimedAt: null,
      claimExpires: null,
      result: resolution === 'returned' ? null : (result ?? null),
      notes:
        note !== undefined ? [...current.notes, {author: holder, at, text: note}] : current.notes
    };
    this.#update(next);
    writeSidecar(this.#vaultDataPath, {...this.#toSpool(next), status: 'claimed'});
    moveEntry(this.#vaultDataPath, next.project, id, 'claimed', next.status);
    this.#logEvent(at, id, resolution, holder, null);
    return {status: 'ok', handoff: next};
  }

  /** returned → open: rework submitted, same record, same id. */
  resubmit(
    id: string,
    updates: {
      from?: {host: string; session: string; repo?: string};
      ref?: {type: HandoffRefType; value: string};
      body?: string;
    },
    now?: string
  ): ResubmitOutcome {
    const at = now ?? new Date().toISOString();
    const current = this.get(id, at);
    if (current === null) return {status: 'not_found'};
    if (current.status !== 'returned') return {status: 'not_returned', current};

    const next: Handoff = {
      ...current,
      status: 'open',
      updated: at,
      ...(updates.ref !== undefined ? {ref: updates.ref} : {}),
      ...(updates.body !== undefined ? {body: updates.body} : {}),
      ...(updates.from !== undefined
        ? {
            from: {
              host: updates.from.host,
              session: updates.from.session,
              repo: updates.from.repo ?? null
            }
          }
        : {})
    };
    this.#update(next);
    writeSidecar(this.#vaultDataPath, {...this.#toSpool(next), status: 'returned'});
    moveEntry(this.#vaultDataPath, next.project, id, 'returned', 'open');
    this.#logEvent(at, id, 'resubmitted', `${next.from.host}/${next.from.session}`, null);
    return {status: 'ok', handoff: next};
  }

  /** Append-only discussion, attached to the work — refused once resolved. */
  note(id: string, author: string, text: string, now?: string): NoteOutcome {
    const at = now ?? new Date().toISOString();
    const current = this.get(id, at);
    if (current === null) return {status: 'not_found'};
    if (current.status === 'done' || current.status === 'rejected') {
      return {status: 'resolved', current};
    }
    const next: Handoff = {
      ...current,
      updated: at,
      notes: [...current.notes, {author, at, text}]
    };
    this.#update(next);
    writeSidecar(this.#vaultDataPath, this.#toSpool(next));
    this.#logEvent(at, id, 'note', author, null);
    return {status: 'ok', handoff: next};
  }

  /** Archival completed: the spool entry (all `<id>.*` siblings) is cleared. */
  clearSpoolEntry(handoff: Handoff): void {
    removeEntry(this.#vaultDataPath, handoff.project, handoff.status, handoff.id);
  }

  events(handoffId?: string, limit = 100): HandoffEvent[] {
    const rows = (handoffId === undefined
      ? this.#db.prepare('SELECT * FROM handoff_events ORDER BY seq DESC LIMIT ?').all(limit)
      : this.#db
          .prepare('SELECT * FROM handoff_events WHERE handoff_id = ? ORDER BY seq DESC LIMIT ?')
          .all(handoffId, limit)) as unknown[] as HandoffEvent[];
    return rows;
  }

  #applyClaim(
    current: Handoff,
    holder: string,
    ttlSeconds: number | undefined,
    at: string
  ): Handoff {
    const ttl = ttlSeconds ?? DEFAULT_CLAIM_TTL_SECONDS;
    const next: Handoff = {
      ...current,
      status: 'claimed',
      updated: at,
      claimedBy: holder,
      claimedAt: current.status === 'claimed' ? current.claimedAt : at,
      claimExpires: new Date(Date.parse(at) + ttl * 1000).toISOString()
    };
    this.#update(next);
    writeSidecar(this.#vaultDataPath, {...this.#toSpool(next), status: current.status});
    return next;
  }

  #revertClaim(handoff: Handoff, at: string): void {
    const next: Handoff = {
      ...handoff,
      status: 'open',
      updated: at,
      claimedBy: null,
      claimedAt: null,
      claimExpires: null,
      result: null // an open handoff carries no verdict (schema CHECK)
    };
    const exists = this.#db.prepare('SELECT 1 FROM handoffs WHERE id = ?').get(handoff.id);
    if (exists) this.#update(next);
    else this.#insert(next);
    writeSidecar(this.#vaultDataPath, {...this.#toSpool(next), status: 'claimed'});
    moveEntry(this.#vaultDataPath, next.project, next.id, 'claimed', 'open');
    this.#logEvent(at, next.id, 'claim_expired', handoff.claimedBy, null);
  }

  #fromSpool(entry: SpoolEntry): Handoff {
    const s = entry.sidecar;
    // Directory is truth: claim fields are honored only inside claimed/ and
    // only as a complete triple; a verdict only inside done/ or rejected/.
    const claimed =
      entry.status === 'claimed' &&
      s.claimed_by !== undefined &&
      s.claimed_at !== undefined &&
      s.claim_expires !== undefined;
    const resolved = entry.status === 'done' || entry.status === 'rejected';
    return {
      id: s.id,
      idempotencyKey: s.idempotency_key,
      project: s.project,
      to: s.to,
      kind: s.kind as HandoffKind,
      ref: s.ref ? {type: s.ref.type, value: s.ref.value} : null,
      from: {host: s.from.host, session: s.from.session, repo: s.from.repo ?? null},
      body: entry.body,
      status: entry.status,
      created: s.created,
      updated: s.updated,
      claimedBy: claimed ? (s.claimed_by as string) : null,
      claimedAt: claimed ? (s.claimed_at as string) : null,
      claimExpires: claimed ? (s.claim_expires as string) : null,
      result: resolved ? (s.result ?? null) : null,
      notes: Array.isArray(s.notes) ? s.notes : []
    };
  }

  #toSpool(handoff: Handoff): SpoolEntry {
    return {status: handoff.status, sidecar: toSidecar(handoff), body: handoff.body};
  }

  #insert(h: Handoff): void {
    this.#db
      .prepare(
        `INSERT INTO handoffs (
           id, idempotency_key, project, to_role, kind, ref_type, ref_value,
           from_host, from_session, from_repo, body, status, created, updated,
           claimed_by, claimed_at, claim_expires, result, notes
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        h.id,
        h.idempotencyKey,
        h.project,
        h.to,
        h.kind,
        h.ref?.type ?? null,
        h.ref?.value ?? null,
        h.from.host,
        h.from.session,
        h.from.repo,
        h.body,
        h.status,
        h.created,
        h.updated,
        h.claimedBy,
        h.claimedAt,
        h.claimExpires,
        h.result === null ? null : JSON.stringify(h.result),
        JSON.stringify(h.notes)
      );
  }

  #update(h: Handoff): void {
    this.#db
      .prepare(
        `UPDATE handoffs
            SET status = ?, updated = ?, claimed_by = ?, claimed_at = ?, claim_expires = ?,
                result = ?, notes = ?, ref_type = ?, ref_value = ?, body = ?,
                from_host = ?, from_session = ?, from_repo = ?
          WHERE id = ?`
      )
      .run(
        h.status,
        h.updated,
        h.claimedBy,
        h.claimedAt,
        h.claimExpires,
        h.result === null ? null : JSON.stringify(h.result),
        JSON.stringify(h.notes),
        h.ref?.type ?? null,
        h.ref?.value ?? null,
        h.body,
        h.from.host,
        h.from.session,
        h.from.repo,
        h.id
      );
  }

  #logEvent(
    at: string,
    handoffId: string,
    event: HandoffEvent['event'],
    actor: string | null,
    detail: string | null
  ): void {
    this.#db
      .prepare(
        'INSERT INTO handoff_events (at, handoff_id, event, actor, detail) VALUES (?, ?, ?, ?, ?)'
      )
      .run(at, handoffId, event, actor, detail);
  }
}
