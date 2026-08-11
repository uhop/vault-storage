// HTTP handlers over the handoff queue (agent-coordination design, leg 2).
// Same conventions as the /leases family: guard-first validation, closed
// enums named in errors, mutations as JSON POSTs. Reads are flat {count,
// items} — the queue is a handful of in-flight items by design, never a
// paginated archive (resolved handoffs live in vault-data, not here).

import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {buildEdges} from '../../importer/build-edges.ts';
import {SuggestionFiler} from '../../importer/file-suggestions.ts';
import {importFile} from '../../importer/import-file.ts';
import {TagsImporter} from '../../importer/import-tags.ts';
import {parseFrontmatter, serializeFrontmatter} from '../../markdown/frontmatter.ts';
import {ARTIFACT_EXTS, MAX_ARTIFACT_BYTES, type ArtifactExt} from '../../records/handoff-spool.ts';
import {
  HANDOFF_KINDS,
  HANDOFF_REF_TYPES,
  HANDOFF_STATUSES,
  HandoffsRepository,
  MAX_CLAIM_TTL_SECONDS,
  MIN_CLAIM_TTL_SECONDS,
  SPOOL_REF_TYPE,
  type Handoff,
  type HandoffKind,
  type HandoffRefType,
  type HandoffStatus
} from '../../records/handoffs.ts';
import type {RecordsRepository} from '../../records/repository.ts';
import {readBodyBuffer, readBodyText} from '../body.ts';
import {NO_QUERY_PARAMS, rejectUnknownParams} from '../query.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

export interface HandoffDeps {
  db: DatabaseSync;
  records: RecordsRepository;
  vaultDataPath: string;
}

const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

const toApi = (h: Handoff): Record<string, unknown> => ({
  id: h.id,
  idempotency_key: h.idempotencyKey,
  project: h.project,
  to: h.to,
  kind: h.kind,
  ref: h.ref,
  from: h.from,
  body: h.body,
  status: h.status,
  created: h.created,
  updated: h.updated,
  claimed_by: h.claimedBy,
  claimed_at: h.claimedAt,
  claim_expires: h.claimExpires,
  result: h.result,
  notes: h.notes,
  artifact: h.artifact
});

interface ParsedBody {
  body: Record<string, unknown>;
}

const readJsonBody = async (ctx: Parameters<Handler>[0]): Promise<ParsedBody | null> => {
  let raw: string;
  try {
    raw = await readBodyText(ctx.req);
  } catch (err) {
    sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendError(ctx.res, 400, 'bad_request', 'request body must be a JSON object');
      return null;
    }
    return {body: parsed as Record<string, unknown>};
  } catch (err) {
    sendError(ctx.res, 400, 'bad_request', `invalid JSON: ${(err as Error).message}`);
    return null;
  }
};

const requireString = (
  ctx: Parameters<Handler>[0],
  body: Record<string, unknown>,
  key: string
): string | null => {
  const v = body[key];
  if (typeof v !== 'string' || v.length === 0) {
    sendError(ctx.res, 400, 'bad_request', `${key} must be a non-empty string`);
    return null;
  }
  return v;
};

const parseTtl = (
  ctx: Parameters<Handler>[0],
  body: Record<string, unknown>
): number | null | undefined => {
  const raw = body['ttl_seconds'];
  if (raw === undefined) return undefined;
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < MIN_CLAIM_TTL_SECONDS ||
    raw > MAX_CLAIM_TTL_SECONDS
  ) {
    sendError(
      ctx.res,
      400,
      'bad_request',
      `ttl_seconds must be an integer in ${MIN_CLAIM_TTL_SECONDS}..${MAX_CLAIM_TTL_SECONDS}`
    );
    return null;
  }
  return raw;
};

const LIST_PARAMS: ReadonlySet<string> = new Set(['to', 'project', 'status', 'kind']);
const EVENTS_PARAMS: ReadonlySet<string> = new Set(['id', 'limit']);
const ARTIFACT_PARAMS: ReadonlySet<string> = new Set(['ext', 'actor']);

/** GET /handoffs[?to=…&project=…&status=…&kind=…] — flat {count, items}. */
export const listHandoffsHandler =
  (deps: HandoffDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, LIST_PARAMS)) return;
    const status = ctx.query['status'];
    if (status !== undefined && !(HANDOFF_STATUSES as readonly string[]).includes(status)) {
      sendError(
        ctx.res,
        400,
        'bad_request',
        `status must be one of: ${HANDOFF_STATUSES.join(', ')}`
      );
      return;
    }
    const kind = ctx.query['kind'];
    if (kind !== undefined && !(HANDOFF_KINDS as readonly string[]).includes(kind)) {
      sendError(ctx.res, 400, 'bad_request', `kind must be one of: ${HANDOFF_KINDS.join(', ')}`);
      return;
    }
    const repo = new HandoffsRepository(deps.db, deps.vaultDataPath);
    const items = repo
      .list({
        ...(ctx.query['to'] !== undefined ? {to: ctx.query['to']} : {}),
        ...(ctx.query['project'] !== undefined ? {project: ctx.query['project']} : {}),
        ...(status !== undefined ? {status: status as HandoffStatus} : {}),
        ...(kind !== undefined ? {kind: kind as HandoffKind} : {})
      })
      .map(toApi);
    sendJson(ctx.res, 200, {count: items.length, items});
  };

/** GET /handoffs/events[?id=…&limit=N] — the append-only transcript, newest first. */
export const handoffEventsHandler =
  (deps: HandoffDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, EVENTS_PARAMS)) return;
    const rawLimit = ctx.query['limit'];
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
      sendError(ctx.res, 400, 'bad_request', 'limit must be an integer in 1..1000');
      return;
    }
    const repo = new HandoffsRepository(deps.db, deps.vaultDataPath);
    const items = repo.events(ctx.query['id'], limit);
    sendJson(ctx.res, 200, {count: items.length, items});
  };

/** GET /handoffs/{id} — the poller's read; 404 only when genuinely gone. */
export const getHandoffHandler =
  (deps: HandoffDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const id = ctx.params['id'] ?? '';
    const handoff = new HandoffsRepository(deps.db, deps.vaultDataPath).get(id);
    if (handoff === null) {
      sendError(ctx.res, 404, 'handoff_not_found', `no handoff: ${id}`);
      return;
    }
    sendJson(ctx.res, 200, toApi(handoff));
  };

/**
 * POST /handoffs — file a work request addressed to a role. The idempotency
 * key is mandatory: a failed create is ambiguous, and a retry must return
 * the original instead of filing twice.
 */
export const createHandoffHandler =
  (deps: HandoffDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const parsed = await readJsonBody(ctx);
    if (!parsed) return;
    const {body} = parsed;

    const idempotencyKey = requireString(ctx, body, 'idempotency_key');
    if (idempotencyKey === null) return;
    const project = requireString(ctx, body, 'project');
    if (project === null) return;
    if (!PROJECT_NAME_RE.test(project)) {
      sendError(ctx.res, 400, 'bad_request', 'project must be a kebab-case vault project name');
      return;
    }
    const to = requireString(ctx, body, 'to');
    if (to === null) return;
    const kindRaw = requireString(ctx, body, 'kind');
    if (kindRaw === null) return;
    if (!(HANDOFF_KINDS as readonly string[]).includes(kindRaw)) {
      sendError(ctx.res, 400, 'bad_request', `kind must be one of: ${HANDOFF_KINDS.join(', ')}`);
      return;
    }
    const prose = requireString(ctx, body, 'body');
    if (prose === null) return;

    const fromRaw = body['from'];
    if (fromRaw === null || typeof fromRaw !== 'object' || Array.isArray(fromRaw)) {
      sendError(ctx.res, 400, 'bad_request', 'from must be an object {host, session, repo?}');
      return;
    }
    const from = fromRaw as Record<string, unknown>;
    if (
      typeof from['host'] !== 'string' ||
      from['host'].length === 0 ||
      typeof from['session'] !== 'string' ||
      from['session'].length === 0
    ) {
      sendError(
        ctx.res,
        400,
        'bad_request',
        'from.host and from.session must be non-empty strings'
      );
      return;
    }
    if (
      from['repo'] !== undefined &&
      (typeof from['repo'] !== 'string' || from['repo'].length === 0)
    ) {
      sendError(ctx.res, 400, 'bad_request', 'from.repo must be a non-empty string when set');
      return;
    }

    const refRaw = body['ref'];
    let ref: {type: HandoffRefType; value: string} | undefined;
    if (refRaw !== undefined) {
      if (refRaw === null || typeof refRaw !== 'object' || Array.isArray(refRaw)) {
        sendError(ctx.res, 400, 'bad_request', 'ref must be an object {type, value}');
        return;
      }
      const r = refRaw as Record<string, unknown>;
      if (
        typeof r['type'] !== 'string' ||
        !(HANDOFF_REF_TYPES as readonly string[]).includes(r['type'])
      ) {
        sendError(
          ctx.res,
          400,
          'bad_request',
          `ref.type must be one of: ${HANDOFF_REF_TYPES.join(', ')} — "${SPOOL_REF_TYPE}" is set by the server when you PUT /handoffs/{id}/artifact, not declared here`
        );
        return;
      }
      if (typeof r['value'] !== 'string' || r['value'].length === 0) {
        sendError(ctx.res, 400, 'bad_request', 'ref.value must be a non-empty string');
        return;
      }
      ref = {type: r['type'] as HandoffRefType, value: r['value']};
    }

    const outcome = new HandoffsRepository(deps.db, deps.vaultDataPath).create({
      idempotencyKey,
      project,
      to,
      kind: kindRaw as HandoffKind,
      ...(ref !== undefined ? {ref} : {}),
      from: {
        host: from['host'],
        session: from['session'],
        ...(from['repo'] !== undefined ? {repo: from['repo'] as string} : {})
      },
      body: prose
    });
    sendJson(ctx.res, 200, {status: outcome.status, handoff: toApi(outcome.handoff)});
  };

/** POST /handoffs/claim — open → claimed; re-claim by the claimant renews the TTL. */
export const claimHandoffHandler =
  (deps: HandoffDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const parsed = await readJsonBody(ctx);
    if (!parsed) return;
    const {body} = parsed;
    const id = requireString(ctx, body, 'id');
    if (id === null) return;
    const holder = requireString(ctx, body, 'holder');
    if (holder === null) return;
    const ttl = parseTtl(ctx, body);
    if (ttl === null) return;

    const outcome = new HandoffsRepository(deps.db, deps.vaultDataPath).claim(id, holder, ttl);
    switch (outcome.status) {
      case 'claimed':
      case 'renewed':
        sendJson(ctx.res, 200, {status: outcome.status, handoff: toApi(outcome.handoff)});
        return;
      case 'not_found':
        sendError(ctx.res, 404, 'handoff_not_found', `no handoff: ${id}`);
        return;
      case 'claimed_by_other':
        sendError(
          ctx.res,
          409,
          'claimed_by_other',
          `${id} is claimed by ${outcome.current.claimedBy}`,
          {
            current: toApi(outcome.current)
          }
        );
        return;
      case 'not_open':
        sendError(ctx.res, 409, 'not_open', `${id} is ${outcome.current.status}, not open`, {
          current: toApi(outcome.current)
        });
        return;
    }
  };

/**
 * POST /handoffs/resolve — the claimant's verdict: done | rejected |
 * returned. done/rejected archive into vault-data and clear the spool entry;
 * returned reopens the same handoff with the critique appended to notes
 * (note is mandatory there — a return without a critique is a drop).
 */
export const resolveHandoffHandler =
  (deps: HandoffDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const parsed = await readJsonBody(ctx);
    if (!parsed) return;
    const {body} = parsed;
    const id = requireString(ctx, body, 'id');
    if (id === null) return;
    const holder = requireString(ctx, body, 'holder');
    if (holder === null) return;
    const resolution = requireString(ctx, body, 'resolution');
    if (resolution === null) return;
    if (!['done', 'rejected', 'returned'].includes(resolution)) {
      sendError(ctx.res, 400, 'bad_request', 'resolution must be one of: done, rejected, returned');
      return;
    }
    const resultRaw = body['result'];
    if (
      resultRaw !== undefined &&
      (resultRaw === null || typeof resultRaw !== 'object' || Array.isArray(resultRaw))
    ) {
      sendError(ctx.res, 400, 'bad_request', 'result must be an object when set');
      return;
    }
    const noteRaw = body['note'];
    if (noteRaw !== undefined && (typeof noteRaw !== 'string' || noteRaw.length === 0)) {
      sendError(ctx.res, 400, 'bad_request', 'note must be a non-empty string when set');
      return;
    }
    if (resolution === 'returned' && noteRaw === undefined) {
      sendError(
        ctx.res,
        400,
        'bad_request',
        'returned requires a note — the critique the rework needs'
      );
      return;
    }

    const repo = new HandoffsRepository(deps.db, deps.vaultDataPath);
    const outcome = repo.resolve(
      id,
      holder,
      resolution as 'done' | 'rejected' | 'returned',
      resultRaw as Record<string, unknown> | undefined,
      noteRaw as string | undefined
    );
    switch (outcome.status) {
      case 'ok':
        break;
      case 'not_found':
        sendError(ctx.res, 404, 'handoff_not_found', `no handoff: ${id}`);
        return;
      case 'not_claimed':
        sendError(
          ctx.res,
          409,
          'not_claimed',
          `${id} is ${outcome.current.status} — claim it first`,
          {
            current: toApi(outcome.current)
          }
        );
        return;
      case 'not_holder':
        sendError(
          ctx.res,
          409,
          'claimed_by_other',
          `${id} is claimed by ${outcome.current.claimedBy}, not ${holder}`,
          {current: toApi(outcome.current)}
        );
        return;
    }

    if (outcome.handoff.status === 'done' || outcome.handoff.status === 'rejected') {
      const archivedTo = completeHandoffArchival(deps, repo, outcome.handoff);
      sendJson(ctx.res, 200, {
        status: 'ok',
        handoff: toApi(outcome.handoff),
        archived_to: archivedTo
      });
      return;
    }
    sendJson(ctx.res, 200, {status: 'ok', handoff: toApi(outcome.handoff)});
  };

/** POST /handoffs/resubmit — the submitter's rework: returned → open, same record. */
export const resubmitHandoffHandler =
  (deps: HandoffDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const parsed = await readJsonBody(ctx);
    if (!parsed) return;
    const {body} = parsed;
    const id = requireString(ctx, body, 'id');
    if (id === null) return;

    const updates: Parameters<HandoffsRepository['resubmit']>[1] = {};
    if (body['body'] !== undefined) {
      const prose = requireString(ctx, body, 'body');
      if (prose === null) return;
      updates.body = prose;
    }
    if (body['ref'] !== undefined) {
      const r = body['ref'];
      if (r === null || typeof r !== 'object' || Array.isArray(r)) {
        sendError(ctx.res, 400, 'bad_request', 'ref must be an object {type, value}');
        return;
      }
      const refObj = r as Record<string, unknown>;
      if (
        typeof refObj['type'] !== 'string' ||
        !(HANDOFF_REF_TYPES as readonly string[]).includes(refObj['type']) ||
        typeof refObj['value'] !== 'string' ||
        refObj['value'].length === 0
      ) {
        sendError(
          ctx.res,
          400,
          'bad_request',
          `ref must be {type: ${HANDOFF_REF_TYPES.join(' | ')}, value: non-empty string}`
        );
        return;
      }
      updates.ref = {type: refObj['type'] as HandoffRefType, value: refObj['value']};
    }
    if (body['from'] !== undefined) {
      const f = body['from'];
      if (
        f === null ||
        typeof f !== 'object' ||
        Array.isArray(f) ||
        typeof (f as Record<string, unknown>)['host'] !== 'string' ||
        typeof (f as Record<string, unknown>)['session'] !== 'string'
      ) {
        sendError(ctx.res, 400, 'bad_request', 'from must be an object {host, session, repo?}');
        return;
      }
      const fromObj = f as Record<string, unknown>;
      updates.from = {
        host: fromObj['host'] as string,
        session: fromObj['session'] as string,
        ...(typeof fromObj['repo'] === 'string' ? {repo: fromObj['repo']} : {})
      };
    }

    const outcome = new HandoffsRepository(deps.db, deps.vaultDataPath).resubmit(id, updates);
    switch (outcome.status) {
      case 'ok':
        sendJson(ctx.res, 200, {status: 'ok', handoff: toApi(outcome.handoff)});
        return;
      case 'not_found':
        sendError(ctx.res, 404, 'handoff_not_found', `no handoff: ${id}`);
        return;
      case 'not_returned':
        sendError(
          ctx.res,
          409,
          'not_returned',
          `${id} is ${outcome.current.status} — only a returned handoff can be resubmitted`,
          {current: toApi(outcome.current)}
        );
        return;
    }
  };

/** POST /handoffs/note — append-only discussion; refused once resolved. */
export const noteHandoffHandler =
  (deps: HandoffDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const parsed = await readJsonBody(ctx);
    if (!parsed) return;
    const {body} = parsed;
    const id = requireString(ctx, body, 'id');
    if (id === null) return;
    const author = requireString(ctx, body, 'author');
    if (author === null) return;
    const text = requireString(ctx, body, 'text');
    if (text === null) return;

    const outcome = new HandoffsRepository(deps.db, deps.vaultDataPath).note(id, author, text);
    switch (outcome.status) {
      case 'ok':
        sendJson(ctx.res, 200, {status: 'ok', handoff: toApi(outcome.handoff)});
        return;
      case 'not_found':
        sendError(ctx.res, 404, 'handoff_not_found', `no handoff: ${id}`);
        return;
      case 'resolved':
        sendError(
          ctx.res,
          409,
          'handoff_resolved',
          `${id} is ${outcome.current.status} — its record lives in the archive now`,
          {current: toApi(outcome.current)}
        );
        return;
    }
  };

/**
 * PUT /handoffs/{id}/artifact?ext=patch|bundle — the transported work.
 * Body is the raw bytes (a `git format-patch --base=…` series, or a bundle),
 * capped at 10 MB. Exists because agents cannot `git push`: the singleton
 * server's filesystem is the fleet's shared storage, so this same pair moves
 * work between hosts with no extra machinery.
 */
export const putHandoffArtifactHandler =
  (deps: HandoffDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, ARTIFACT_PARAMS)) return;
    const id = ctx.params['id'] ?? '';
    const extRaw = ctx.query['ext'] ?? 'patch';
    if (!(ARTIFACT_EXTS as readonly string[]).includes(extRaw)) {
      sendError(ctx.res, 400, 'bad_request', `ext must be one of: ${ARTIFACT_EXTS.join(', ')}`);
      return;
    }
    const actor = ctx.query['actor'];
    if (actor !== undefined && actor.length === 0) {
      sendError(ctx.res, 400, 'bad_request', 'actor must be a non-empty string when set');
      return;
    }

    let data: Buffer;
    try {
      data = await readBodyBuffer(ctx.req, MAX_ARTIFACT_BYTES);
    } catch {
      sendError(
        ctx.res,
        413,
        'artifact_too_large',
        `artifact exceeds the ${MAX_ARTIFACT_BYTES}-byte spool cap — reference a branch instead of shipping a blob`
      );
      return;
    }
    if (data.length === 0) {
      sendError(ctx.res, 400, 'bad_request', 'artifact body is empty');
      return;
    }

    const outcome = new HandoffsRepository(deps.db, deps.vaultDataPath).putArtifact(
      id,
      extRaw as ArtifactExt,
      data,
      actor ?? 'unknown'
    );
    switch (outcome.status) {
      case 'ok':
        sendJson(ctx.res, 200, {
          status: 'ok',
          handoff: toApi(outcome.handoff),
          artifact: outcome.artifact
        });
        return;
      case 'not_found':
        sendError(ctx.res, 404, 'handoff_not_found', `no handoff: ${id}`);
        return;
      case 'resolved':
        sendError(
          ctx.res,
          409,
          'handoff_resolved',
          `${id} is ${outcome.current.status} — its spool entry is cleared and the archive is the record`,
          {current: toApi(outcome.current)}
        );
        return;
    }
  };

/**
 * GET /handoffs/{id}/artifact — the raw bytes back, for `git am --3way` (or
 * `git bundle verify` + fetch). ETag is the artifact's sha256, so a reviewer
 * can confirm it got what the submitter sent.
 */
export const getHandoffArtifactHandler =
  (deps: HandoffDeps): Handler =>
  ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    const id = ctx.params['id'] ?? '';
    const repo = new HandoffsRepository(deps.db, deps.vaultDataPath);
    const handoff = repo.get(id);
    if (handoff === null) {
      sendError(ctx.res, 404, 'handoff_not_found', `no handoff: ${id}`);
      return;
    }
    const artifact = repo.getArtifact(id);
    if (artifact === null) {
      sendError(ctx.res, 404, 'artifact_not_found', `${id} carries no artifact`);
      return;
    }
    ctx.res.writeHead(200, {
      'Content-Type':
        artifact.ext === 'patch' ? 'text/x-patch; charset=utf-8' : 'application/octet-stream',
      'Content-Length': String(artifact.data.length),
      'Content-Disposition': `attachment; filename="${id}.${artifact.ext}"`,
      ...(handoff.artifact ? {ETag: `"${handoff.artifact.sha256}"`} : {})
    });
    ctx.res.end(artifact.data);
  };

const ARCHIVE_HEADER = (project: string): string =>
  serializeFrontmatter({
    data: {
      title: `${project} — Handoff Archive`,
      tags: [project, 'coordination', 'agent-workflow'],
      created: new Date().toISOString().slice(0, 10),
      updated: new Date().toISOString().slice(0, 10),
      status: 'active',
      type: 'project',
      related: [
        `[[projects/${project}/queue]]`,
        '[[projects/vault-storage/design/agent-coordination]]'
      ]
    },
    body:
      `\nResolved agent handoffs for ${project} — the durable record of cross-agent work` +
      ` requests after their spool entries are cleared (the queue.md → queue-archive.md` +
      ` pattern applied to [[projects/vault-storage/design/agent-coordination]]).\n`
  });

/**
 * The third stage of the lifecycle promotion: spool (in-flight, gitignored) →
 * vault-data (committed history). Appends the resolved handoff to
 * `projects/<project>/handoff-archive.md`, indexes it, then clears the spool
 * entry. Idempotent by the `### <id>` marker, so the server-start recovery
 * path can re-run it after a crash between resolve and archive.
 */
export const completeHandoffArchival = (
  deps: HandoffDeps,
  repo: HandoffsRepository,
  handoff: Handoff
): string => {
  const archivePath = `projects/${handoff.project}/handoff-archive.md`;
  const absolutePath = join(deps.vaultDataPath, archivePath);
  const marker = `### ${handoff.id}`;
  const today = handoff.updated.slice(0, 10);

  let source = existsSync(absolutePath)
    ? readFileSync(absolutePath, 'utf8')
    : ARCHIVE_HEADER(handoff.project);
  if (!source.includes(marker)) {
    const lines: string[] = [
      '',
      marker,
      '',
      `- **${handoff.kind}** → \`${handoff.to}\` — **${handoff.status}**`,
      `- from \`${handoff.from.host}/${handoff.from.session}\`` +
        (handoff.from.repo !== null ? ` (\`${handoff.from.repo}\`)` : '') +
        ` · created ${handoff.created.slice(0, 10)} · resolved ${today}`
    ];
    if (handoff.ref !== null) lines.push(`- ref: \`${handoff.ref.type}: ${handoff.ref.value}\``);
    // The artifact itself is cleared with the spool entry — the work has
    // landed as commits by now — so the archive keeps its fingerprint.
    if (handoff.artifact !== null) {
      const a = handoff.artifact;
      lines.push(`- artifact: \`${a.ext}\`, ${a.bytes} bytes, sha256 \`${a.sha256}\``);
    }
    if (handoff.result !== null) lines.push(`- result: \`${JSON.stringify(handoff.result)}\``);
    lines.push('');
    // Blockquoted so headings inside the request prose can't break the archive's structure.
    lines.push(
      ...handoff.body
        .trimEnd()
        .split('\n')
        .map(line => (line.length > 0 ? `> ${line}` : '>'))
    );
    if (handoff.notes.length > 0) {
      lines.push('', 'Notes:', '');
      for (const note of handoff.notes) {
        lines.push(`- **${note.author}** (${note.at}): ${note.text}`);
      }
    }
    lines.push('');

    const {data, body} = parseFrontmatter(source);
    data['updated'] = today;
    source = serializeFrontmatter({data, body: body.trimEnd() + '\n' + lines.join('\n')});
    mkdirSync(dirname(absolutePath), {recursive: true});
    writeFileSync(absolutePath, source);

    const {recordId} = importFile(deps.records, archivePath, absolutePath, undefined, {
      tags: new TagsImporter(deps.db),
      agentStale: new SuggestionFiler(deps.db, 'agent_enrichment_stale'),
      tagSuggestion: new SuggestionFiler(deps.db, 'tag_suggestion'),
      archiveCandidate: new SuggestionFiler(deps.db, 'archive_candidate')
    });
    buildEdges(deps.db, {vaultRoot: deps.vaultDataPath, scope: new Set([recordId])});
  }

  repo.clearSpoolEntry(handoff);
  return archivePath;
};
