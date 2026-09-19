import type {IncomingMessage} from 'node:http';
import type {DatabaseSync} from 'node:sqlite';
import {bodyRead} from './body.ts';

/**
 * The top-level fields each write route reads from a JSON body; an empty
 * list means the route reads no body. Observed, not enforced (D64): a field
 * outside its route's list is recorded and the request goes through, until a
 * week of observations shows which routes can refuse one.
 */
const FIELDS: Readonly<Record<string, readonly string[]>> = {
  'POST /system/resume-bundle': [],
  'POST /context-pack': [],
  'PATCH /sections/{id}/fm': ['ops'],
  'POST /sections/{id}/tags': ['tag'],
  'PUT /sections/{id}': ['frontmatter', 'body'],
  'POST /tags/taxonomy': ['tag', 'description'],
  'PATCH /tags/taxonomy/{tag}': ['description'],
  'POST /tags/aliases': ['alias', 'canonical'],
  'POST /suggestions': ['kind', 'subject_id', 'payload', 'evidence'],
  'POST /suggestions/claim': ['kind', 'holder', 'limit', 'ttl_seconds'],
  'POST /suggestions/resolve-batch': ['items', 'resolved_by'],
  'POST /suggestions/{id}/accept': ['resolved_by'],
  'POST /suggestions/{id}/reject': ['resolved_by'],
  'POST /suggestions/{id}/reopen': [],
  'PUT /vault/{path}': ['frontmatter', 'body'],
  'POST /vault/edit': [
    'path',
    'op',
    'text',
    'from',
    'to',
    'all',
    'heading',
    'body',
    'title',
    'section',
    'item',
    'position',
    'create_section',
    'occurrence',
    'expected_hash',
    'yaml'
  ],
  'POST /vault/render': ['markdown'],
  'POST /vault/move': ['from', 'to'],
  'POST /vault/move-item': [
    'from_path',
    'to_path',
    'title',
    'from_section',
    'to_section',
    'position',
    'trail',
    'create_section'
  ],
  'POST /vault/supersede': ['old_path', 'new_path', 'frontmatter', 'body'],
  // agent_summary and prefilter_max_distance are refused by name, so they are read.
  'POST /vault/propose': [
    'body',
    'path',
    'k',
    'max_distance',
    'agent_summary',
    'prefilter_max_distance'
  ],
  'PUT /drafts': ['path', 'unit', 'base_hash', 'text'],
  'POST /search/simple/': [],
  'POST /search/simple': [],
  'POST /resolve': ['wikilinks'],
  'POST /commit': ['message', 'paths'],
  'POST /maintenance/find-duplicates': [],
  'POST /maintenance/find-compaction-candidates': [],
  'POST /maintenance/find-retention-candidates': [],
  'POST /maintenance/find-upgrade-signals': [],
  'POST /maintenance/cleanup-lint': [],
  'POST /maintenance/cleanup-tag-aliases': ['aliases'],
  'POST /maintenance/expire-logs': [],
  'POST /maintenance/embed-pending': [],
  'POST /maintenance/release-embedder': [],
  'POST /maintenance/run-all': [],
  'POST /maintenance/snapshot': [],
  'POST /maintenance/incremental-reindex': [],
  'POST /maintenance/reindex-queues': [],
  'POST /leases/claim': ['resource', 'holder', 'kind', 'priority', 'attestation', 'ttl_seconds'],
  'POST /leases/renew': ['resource', 'holder', 'ttl_seconds'],
  'POST /leases/release': ['resource', 'holder', 'force'],
  'POST /leases/transfer': [
    'resource',
    'holder',
    'to_holder',
    'to_kind',
    'to_priority',
    'ttl_seconds'
  ],
  'POST /handoffs': ['idempotency_key', 'project', 'to', 'kind', 'ref', 'from', 'body', 'touches'],
  'POST /handoffs/claim': ['id', 'holder', 'ttl_seconds'],
  'POST /handoffs/resolve': ['id', 'holder', 'resolution', 'result', 'note'],
  'POST /handoffs/resubmit': ['id', 'body', 'ref', 'from', 'touches'],
  'POST /handoffs/note': ['id', 'author', 'text'],
  'POST /handoffs/verify': ['id', 'check', 'sha', 'exit', 'by']
};

export const BODY_FIELDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(FIELDS).map(([route, fields]) => [route, new Set(fields)])
);

/** Write routes whose body is not a JSON object, so they have no fields to declare. */
export const RAW_BODY_ROUTES: ReadonlySet<string> = new Set(['PUT /handoffs/{id}/artifact']);

const OPEN_BRACE = 0x7b;
const CLIENT_MAX = 80;

/**
 * Returns the observer the server calls after each handler: it records the
 * route's JSON request and every top-level field outside the route's list.
 * A body that does not start with `{` (markdown, a patch) is skipped
 * unparsed. Never throws into the request.
 */
export const bodyFieldObserver = (
  db: DatabaseSync
): ((route: string, req: IncomingMessage) => void) => {
  const upsert = db.prepare(
    `INSERT INTO body_field_observations (route, field, client, count, first_seen, last_seen)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT (route, field, client) DO UPDATE SET count = count + 1, last_seen = excluded.last_seen`
  );
  return (route, req) => {
    const fields = BODY_FIELDS.get(route);
    if (fields === undefined) return;
    const raw = bodyRead(req);
    if (raw === undefined) return;
    const start = raw.findIndex(byte => byte > 0x20);
    if (raw[start] !== OPEN_BRACE) return;
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return;
    const client = String(req.headers['user-agent'] ?? '-').slice(0, CLIENT_MAX);
    const at = new Date().toISOString();
    try {
      upsert.run(route, '', client, at, at);
      for (const field of Object.keys(body)) {
        if (!fields.has(field)) upsert.run(route, field, client, at, at);
      }
    } catch (err) {
      process.stderr.write(`body-fields: ${(err as Error).message}\n`);
    }
  };
};

export interface BodyFieldReport {
  since: string | null;
  routes: Array<{
    route: string;
    requests: number;
    clients: Array<{client: string; requests: number}>;
    unknown: Array<{
      field: string;
      count: number;
      clients: string[];
      first_seen: string;
      last_seen: string;
    }>;
  }>;
}

interface ObservationRow {
  route: string;
  field: string;
  client: string;
  count: number;
  first_seen: string;
  last_seen: string;
}

/** Every declared route, with its JSON request count per client and the unknown fields seen on it. */
export const bodyFieldReport = (db: DatabaseSync): BodyFieldReport => {
  const rows = db
    .prepare(
      'SELECT route, field, client, count, first_seen, last_seen FROM body_field_observations ORDER BY route, field, client'
    )
    .all() as unknown[] as ObservationRow[];
  let since: string | null = null;
  const byRoute = new Map<string, BodyFieldReport['routes'][number]>(
    [...BODY_FIELDS.keys()].map(route => [route, {route, requests: 0, clients: [], unknown: []}])
  );
  for (const row of rows) {
    if (since === null || row.first_seen < since) since = row.first_seen;
    const entry = byRoute.get(row.route);
    if (entry === undefined) continue;
    if (row.field === '') {
      entry.requests += row.count;
      entry.clients.push({client: row.client, requests: row.count});
      continue;
    }
    const known = entry.unknown.find(u => u.field === row.field);
    if (known === undefined) {
      entry.unknown.push({
        field: row.field,
        count: row.count,
        clients: [row.client],
        first_seen: row.first_seen,
        last_seen: row.last_seen
      });
    } else {
      known.count += row.count;
      known.clients.push(row.client);
      if (row.first_seen < known.first_seen) known.first_seen = row.first_seen;
      if (row.last_seen > known.last_seen) known.last_seen = row.last_seen;
    }
  }
  return {since, routes: [...byRoute.values()].sort((a, b) => a.route.localeCompare(b.route))};
};
