import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync
} from 'node:fs';
import type {ServerResponse} from 'node:http';
import {basename, dirname, join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {parseFrontmatter} from '../../markdown/frontmatter.ts';
import type {Embedder} from '../../embeddings/types.ts';
import {
  AgentEnrichmentStaleFiler,
  ArchiveCandidateFiler,
  TagSuggestionFiler
} from '../../importer/file-suggestions.ts';
import {importFile} from '../../importer/import-file.ts';
import {TagsImporter} from '../../importer/import-tags.ts';
import {proposeNearest} from '../../maintenance/propose.ts';
import type {RecordsRepository} from '../../records/repository.ts';
import {readBodyText} from '../body.ts';
import type {ResolverCache} from '../resolver-cache.ts';
import {sendError, sendJson, sendNoContent, sendText} from '../responses.ts';
import type {Handler} from '../router.ts';
import {
  ensureSafePath,
  parseWriteRequest,
  WriterError,
  writeRecordToDisk,
  writeSplitRecordToDisk
} from '../writer.ts';

interface VaultDeps {
  db: DatabaseSync;
  vaultDataPath: string;
  embedder: Embedder;
  records: RecordsRepository;
  /** Invalidated on writes that can change the path set (PUT-create, DELETE, move). */
  resolverCache: ResolverCache;
}

/**
 * Compose the children of an atomized folder (one with `_about.md` + pieces)
 * back into a single markdown document — the inverse of `splitFile`. Pieces
 * are ordered by frontmatter `sequence_key` (numeric, ascending), with the
 * filename as a tiebreaker. Each piece is re-prefixed with its `## <title>`
 * heading. The composed document carries the `_about.md`'s frontmatter so
 * downstream readers see one coherent file.
 */
const composeFolder = (folderAbs: string): string | null => {
  const aboutPath = join(folderAbs, '_about.md');
  if (!existsSync(aboutPath)) return null;

  const aboutSource = readFileSync(aboutPath, 'utf8');
  const aboutFm = parseFrontmatter(aboutSource);

  const entries = readdirSync(folderAbs, {withFileTypes: true}).filter(
    e => e.isFile() && e.name.endsWith('.md') && e.name !== '_about.md'
  );

  interface Piece {
    title: string;
    body: string;
    sequenceKey: number;
    name: string;
  }
  const pieces: Piece[] = entries.map(entry => {
    const piecePath = join(folderAbs, entry.name);
    const source = readFileSync(piecePath, 'utf8');
    const {data, body} = parseFrontmatter(source);
    const title =
      typeof data['title'] === 'string' && data['title'].length > 0
        ? data['title']
        : basename(entry.name, '.md');
    const sequenceKey =
      typeof data['sequence_key'] === 'number' && Number.isFinite(data['sequence_key'])
        ? (data['sequence_key'] as number)
        : Number.MAX_SAFE_INTEGER;
    return {title, body: body.replace(/\s+$/, ''), sequenceKey, name: entry.name};
  });

  pieces.sort((a, b) => a.sequenceKey - b.sequenceKey || a.name.localeCompare(b.name));

  const head =
    Object.keys(aboutFm.data).length > 0
      ? aboutSource.slice(0, aboutSource.length - aboutFm.body.length)
      : '';
  const composedBody = pieces.map(p => `## ${p.title}\n\n${p.body}\n`).join('\n');
  return head + composedBody;
};

const safePathOrError = (
  vaultRoot: string,
  filePath: string,
  res: ServerResponse
): string | null => {
  try {
    return ensureSafePath(vaultRoot, filePath);
  } catch (err) {
    if (err instanceof WriterError) {
      sendError(res, err.status, err.code, err.message);
      return null;
    }
    throw err;
  }
};

const listFolder = (vaultRoot: string, relativePath: string, res: ServerResponse): void => {
  let folderAbs: string;
  if (relativePath.length === 0) {
    folderAbs = vaultRoot;
  } else {
    const safe = safePathOrError(vaultRoot, relativePath, res);
    if (safe === null) return;
    folderAbs = safe;
  }

  if (!existsSync(folderAbs) || !statSync(folderAbs).isDirectory()) {
    sendError(res, 404, 'not_found', `no folder at ${relativePath || '/'}`);
    return;
  }

  const entries = readdirSync(folderAbs, {withFileTypes: true})
    .filter(e => !e.name.startsWith('.'))
    .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort();

  sendJson(res, 200, {files: entries});
};

/** GET /vault/{path} — file read, or compose-on-demand for atomized folders. */
export const getVaultHandler =
  (deps: VaultDeps): Handler =>
  ctx => {
    const path = ctx.params['path'] ?? '';
    if (path.endsWith('/')) {
      listFolder(deps.vaultDataPath, path.slice(0, -1), ctx.res);
      return;
    }

    const abs = safePathOrError(deps.vaultDataPath, path, ctx.res);
    if (abs === null) return;

    if (existsSync(abs) && statSync(abs).isFile()) {
      // Phase E: bump last_referenced for the record at this path (when
      // we have one — atomized folder pieces are recorded individually,
      // raw files outside the index simply won't match).
      const {records} = deps;
      const rec = records.getByPath(path);
      if (rec) records.bumpLastReferenced(rec.recordId);
      sendText(ctx.res, 200, 'text/markdown; charset=utf-8', readFileSync(abs, 'utf8'));
      return;
    }

    if (path.endsWith('.md')) {
      const folderAbs = abs.slice(0, -'.md'.length);
      if (existsSync(folderAbs) && statSync(folderAbs).isDirectory()) {
        const composed = composeFolder(folderAbs);
        if (composed !== null) {
          sendText(ctx.res, 200, 'text/markdown; charset=utf-8', composed);
          return;
        }
      }
    }

    sendError(ctx.res, 404, 'not_found', `no file at ${path}`);
  };

/** GET /vault/ — list the vault root. */
export const getVaultRootHandler =
  (deps: VaultDeps): Handler =>
  ctx => {
    listFolder(deps.vaultDataPath, '', ctx.res);
  };

/**
 * Extract `agent.summary` from a frontmatter object if present, returning
 * null otherwise. Mirrors the indexer's lookup so the dedup check uses
 * the same chunk-prefix the eventual stored record will.
 */
const extractAgentSummary = (frontmatter: Record<string, unknown>): string | null => {
  const agent = frontmatter['agent'];
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return null;
  const summary = (agent as Record<string, unknown>)['summary'];
  return typeof summary === 'string' && summary.length > 0 ? summary : null;
};

/**
 * PUT /vault/{path} — create or replace a file.
 *
 * `?check=true` opts into the search-before-write dedup gate: the
 * proposed body is embedded and scored against existing records via
 * the same metric as `find-duplicates`. Any candidate whose distance
 * is `≤ check_threshold` (default 0.10) blocks the write with a 409
 * carrying the offending candidates. Without the query param, behavior
 * is unchanged — naked PUT remains the existing contract.
 *
 * `X-Vault-Dedup: skip` short-circuits the check when the caller has
 * already run /vault/propose and made an explicit decision; useful so
 * the propose-then-write idiom doesn't double-charge the embedder.
 */
export const putVaultHandler =
  (deps: VaultDeps): Handler =>
  async ctx => {
    const path = ctx.params['path'] ?? '';
    if (path.length === 0 || path.endsWith('/')) {
      sendError(ctx.res, 400, 'invalid_path', 'PUT requires a file path (no trailing slash)');
      return;
    }
    if (!path.endsWith('.md')) {
      sendError(ctx.res, 400, 'invalid_path', 'only .md files are supported');
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }

    const {records} = deps;
    const tags = new TagsImporter(deps.db);
    const agentStale = new AgentEnrichmentStaleFiler(deps.db);
    const tagSuggestion = new TagSuggestionFiler(deps.db);
    const archiveCandidate = new ArchiveCandidateFiler(deps.db);
    const existing = records.getByPath(path);

    let parsed: ReturnType<typeof parseWriteRequest>;
    try {
      parsed = parseWriteRequest(rawBody, ctx.req.headers['content-type']);
    } catch (err) {
      if (err instanceof WriterError) {
        sendError(ctx.res, err.status, err.code, err.message);
        return;
      }
      throw err;
    }

    // Dedup gate. `?check=true` arms it; `X-Vault-Dedup: skip` disarms.
    const checkParam = ctx.query['check'];
    const dedupHeader = (ctx.req.headers['x-vault-dedup'] ?? '').toString().toLowerCase();
    if (checkParam === 'true' && dedupHeader !== 'skip') {
      const thresholdRaw = ctx.query['check_threshold'];
      let threshold = 0.1;
      if (thresholdRaw !== undefined) {
        const n = Number(thresholdRaw);
        if (!Number.isFinite(n) || n < 0) {
          sendError(ctx.res, 400, 'bad_request', 'check_threshold must be a non-negative number');
          return;
        }
        threshold = n;
      }

      // Pull the body+summary from the parsed write — the same content
      // that's about to be persisted, so the dedup result reflects what
      // would actually land.
      let bodyForCheck: string;
      let summaryForCheck: string | null;
      if (parsed.kind === 'json') {
        bodyForCheck = parsed.body;
        summaryForCheck = extractAgentSummary(parsed.frontmatter);
      } else {
        const fm = parseFrontmatter(parsed.markdown);
        bodyForCheck = fm.body;
        summaryForCheck = extractAgentSummary(fm.data);
      }

      const result = await proposeNearest(deps.db, deps.embedder, bodyForCheck, summaryForCheck, {
        excludeRecordId: existing?.recordId,
        k: 10
      });
      const tooClose = result.candidates.filter(c => c.distance <= threshold);
      if (tooClose.length > 0) {
        sendJson(ctx.res, 409, {
          error: 'dedup_conflict',
          code: 'dedup_conflict',
          message: `${tooClose.length} existing record(s) within distance ${threshold} of the proposed body`,
          threshold,
          candidates: tooClose.map(c => ({
            record_id: c.recordId,
            file_path: c.filePath,
            distance: c.distance,
            agent_summary: c.agentSummary
          }))
        });
        return;
      }
    }

    let absolutePath: string;
    try {
      const result =
        parsed.kind === 'json'
          ? writeSplitRecordToDisk({
              filePath: path,
              existing,
              frontmatter: parsed.frontmatter,
              body: parsed.body,
              vaultDataPath: deps.vaultDataPath
            })
          : writeRecordToDisk({
              filePath: path,
              existing,
              requestMarkdown: parsed.markdown,
              vaultDataPath: deps.vaultDataPath
            });
      absolutePath = result.absolutePath;
    } catch (err) {
      if (err instanceof WriterError) {
        sendError(ctx.res, err.status, err.code, err.message);
        return;
      }
      throw err;
    }

    importFile(records, path, absolutePath, undefined, {
      tags,
      agentStale,
      tagSuggestion,
      archiveCandidate
    });
    // A create adds a path the cached wikilink resolver doesn't know.
    if (!existing) deps.resolverCache.invalidate();
    sendNoContent(ctx.res);
  };

/** DELETE /vault/{path} — remove a file from disk and DB. */
export const deleteVaultHandler =
  (deps: VaultDeps): Handler =>
  ctx => {
    const path = ctx.params['path'] ?? '';
    if (path.length === 0 || path.endsWith('/')) {
      sendError(ctx.res, 400, 'invalid_path', 'DELETE requires a file path (no trailing slash)');
      return;
    }

    const abs = safePathOrError(deps.vaultDataPath, path, ctx.res);
    if (abs === null) return;

    const onDisk = existsSync(abs) && statSync(abs).isFile();
    const {records} = deps;
    const existing = records.getByPath(path);

    if (!onDisk && !existing) {
      sendError(ctx.res, 404, 'not_found', `no file at ${path}`);
      return;
    }

    if (onDisk) unlinkSync(abs);
    if (existing) {
      records.delete(existing.recordId);
      deps.resolverCache.invalidate();
    }

    sendNoContent(ctx.res);
  };

/**
 * POST /vault/move — atomic file rename that preserves `record_id`.
 *
 * Body: `{from: "<source>", to: "<dest>"}`. Both must be vault-relative
 * `.md` paths.
 *
 * Use case: `/vault-compact` archives pieces by moving them into
 * `<folder>/archive/<YYYY>/`. The naive shape (DELETE old + PUT new)
 * generated a fresh `record_id` under the archive path, which made the
 * EdgeTypeFiler refile every body wikilink as a new `cites` suggestion
 * (idempotency key is `(from_record, to_record)`). This endpoint renames
 * the file on disk and updates `records.file_path` on the existing row
 * — `record_id` survives, and so do the edges / tags / suggestions /
 * embeddings derived from it.
 *
 * Returns 204 on success, 404 if source missing, 409 on destination
 * conflict, 400 on invalid paths.
 */
export const moveVaultHandler =
  (deps: VaultDeps): Handler =>
  async ctx => {
    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      sendError(ctx.res, 400, 'invalid_json', 'request body must be JSON');
      return;
    }
    const body = parsed as {from?: unknown; to?: unknown};
    const fromPath = body.from;
    const toPath = body.to;
    if (typeof fromPath !== 'string' || typeof toPath !== 'string') {
      sendError(ctx.res, 400, 'invalid_path', 'both `from` and `to` must be strings');
      return;
    }
    if (!fromPath.endsWith('.md') || !toPath.endsWith('.md')) {
      sendError(ctx.res, 400, 'invalid_path', 'both paths must end with .md');
      return;
    }
    if (fromPath.endsWith('/') || toPath.endsWith('/')) {
      sendError(ctx.res, 400, 'invalid_path', 'paths must not end with a slash');
      return;
    }
    if (fromPath === toPath) {
      sendError(ctx.res, 400, 'invalid_path', '`from` and `to` are identical');
      return;
    }

    const fromAbs = safePathOrError(deps.vaultDataPath, fromPath, ctx.res);
    if (fromAbs === null) return;
    const toAbs = safePathOrError(deps.vaultDataPath, toPath, ctx.res);
    if (toAbs === null) return;

    const {records} = deps;
    const existing = records.getByPath(fromPath);
    if (!existing) {
      sendError(ctx.res, 404, 'not_found', `no record at ${fromPath}`);
      return;
    }
    if (records.getByPath(toPath)) {
      sendError(ctx.res, 409, 'conflict', `destination already exists in records: ${toPath}`);
      return;
    }
    if (!existsSync(fromAbs)) {
      sendError(ctx.res, 404, 'not_found', `source file not found on disk: ${fromPath}`);
      return;
    }
    if (existsSync(toAbs)) {
      sendError(ctx.res, 409, 'conflict', `destination file already exists on disk: ${toPath}`);
      return;
    }

    // Disk rename first (more likely to fail than a single-row UPDATE).
    // mkdirSync is idempotent with `recursive: true`; harmless if dir exists.
    mkdirSync(dirname(toAbs), {recursive: true});
    renameSync(fromAbs, toAbs);

    // DB update — preserves record_id, and therefore every reference to it
    // (edges, tags, suggestions, embeddings, agent block).
    records.updateFilePath(existing.recordId, toPath);
    deps.resolverCache.invalidate();

    sendNoContent(ctx.res);
  };

interface ProposeBody {
  body?: unknown;
  path?: unknown;
  agent_summary?: unknown;
  k?: unknown;
  prefilter_max_distance?: unknown;
}

/**
 * POST /vault/propose
 *
 * Search-before-write surface. Body: `{body, path?, agent_summary?,
 * k?, prefilter_max_distance?}`. Embeds `body` (chunk-level + summary-
 * decorated, same pipeline as ingest) and returns the top-K nearest
 * existing records sorted by min cosine distance over chunk pairs.
 *
 * When `path` is supplied AND there's already a record at that path,
 * that record is excluded from results — without this, a small FM-only
 * edit would always self-match at distance ≈ 0 and crowd out actual
 * neighbours.
 *
 * Returns `{candidates: [{record_id, file_path, distance,
 * agent_summary}], proposed_chunks, candidates_screened, durationMs}`.
 * Read-only — no write side effects.
 *
 * Pairs with PUT /vault/{path}?check=true (Phase 2) for enforcement;
 * called directly by skills that want to surface neighbours to a
 * human-in-the-loop before committing the write.
 */
export const proposeVaultHandler =
  (deps: VaultDeps): Handler =>
  async ctx => {
    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }
    if (raw.trim().length === 0) {
      sendError(ctx.res, 400, 'bad_request', 'request body required');
      return;
    }
    let parsed: ProposeBody;
    try {
      const obj = JSON.parse(raw) as unknown;
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        sendError(ctx.res, 400, 'bad_request', 'request body must be a JSON object');
        return;
      }
      parsed = obj as ProposeBody;
    } catch (err) {
      sendError(ctx.res, 400, 'bad_request', `invalid JSON: ${(err as Error).message}`);
      return;
    }
    if (typeof parsed.body !== 'string' || parsed.body.length === 0) {
      sendError(ctx.res, 400, 'bad_request', 'body must be a non-empty string');
      return;
    }
    if (parsed.path !== undefined && typeof parsed.path !== 'string') {
      sendError(ctx.res, 400, 'bad_request', 'path must be a string when provided');
      return;
    }
    const agentSummary =
      typeof parsed.agent_summary === 'string' && parsed.agent_summary.length > 0
        ? parsed.agent_summary
        : null;
    const k =
      typeof parsed.k === 'number' && Number.isInteger(parsed.k) && parsed.k > 0
        ? parsed.k
        : undefined;
    const prefilterMaxDistance =
      typeof parsed.prefilter_max_distance === 'number' &&
      Number.isFinite(parsed.prefilter_max_distance) &&
      parsed.prefilter_max_distance > 0
        ? parsed.prefilter_max_distance
        : undefined;

    let excludeRecordId: string | undefined;
    if (typeof parsed.path === 'string' && parsed.path.length > 0) {
      const existing = deps.records.getByPath(parsed.path);
      if (existing) excludeRecordId = existing.recordId;
    }

    const result = await proposeNearest(deps.db, deps.embedder, parsed.body, agentSummary, {
      k,
      prefilterMaxDistance,
      excludeRecordId
    });

    sendJson(ctx.res, 200, {
      candidates: result.candidates.map(c => ({
        record_id: c.recordId,
        file_path: c.filePath,
        distance: c.distance,
        agent_summary: c.agentSummary
      })),
      proposed_chunks: result.proposedChunks,
      candidates_screened: result.candidatesScreened,
      durationMs: result.durationMs
    });
  };
