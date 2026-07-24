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
import {buildEdges} from '../../importer/build-edges.ts';
import {SuggestionFiler} from '../../importer/file-suggestions.ts';
import {importFile} from '../../importer/import-file.ts';
import {TagsImporter} from '../../importer/import-tags.ts';
import {proposeNearest} from '../../maintenance/propose.ts';
import type {RecordsRepository} from '../../records/repository.ts';
import {readBodyText} from '../body.ts';
import type {ResolverCache} from '../resolver-cache.ts';
import {sendError, sendJson, sendNoContent, sendText} from '../responses.ts';
import type {Handler} from '../router.ts';
import {
  documentEtag,
  ensureSafePath,
  parseWriteRequest,
  validateWritePayload,
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
      sendError(res, err.status, err.code, err.message, err.details);
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
      const document = readFileSync(abs, 'utf8');
      sendText(ctx.res, 200, 'text/markdown; charset=utf-8', document, {
        ETag: `"${documentEtag(document)}"`
      });
      return;
    }

    if (path.endsWith('.md')) {
      const folderAbs = abs.slice(0, -'.md'.length);
      if (existsSync(folderAbs) && statSync(folderAbs).isDirectory()) {
        const composed = composeFolder(folderAbs);
        if (composed !== null) {
          // Weak ETag: the document is virtual (no single on-disk file), so
          // If-Match's strong comparison can never succeed against it — a
          // conditional PUT 412s by design. W/ + the explicit header let
          // round-trip clients (vault-put) detect the case instead of
          // misreading the 412 as a concurrency conflict (2026-07-14).
          sendText(ctx.res, 200, 'text/markdown; charset=utf-8', composed, {
            ETag: `W/"${documentEtag(composed)}"`,
            'X-Vault-Composed': 'true'
          });
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

    // Guard writes that target a composed view rather than a file. Both
    // branches exist because of the 2026-07-14 incident: conditional PUTs
    // against a composed path 412'd with a message that read as a concurrency
    // conflict, and the unconditional-PUT "workaround" then materialized flat
    // files that shadowed the atomized folders.
    const absTarget = safePathOrError(deps.vaultDataPath, path, ctx.res);
    if (absTarget === null) return;
    if (!existsSync(absTarget) || !statSync(absTarget).isFile()) {
      const folder = path.slice(0, -'.md'.length);
      if (existsSync(join(absTarget.slice(0, -'.md'.length), '_about.md'))) {
        if (typeof ctx.req.headers['if-match'] === 'string') {
          sendError(
            ctx.res,
            412,
            'precondition_failed',
            `no file exists at ${path} — it is composed on demand from the atomized folder ${folder}/, and conditional writes cannot create files. Edit the folder's pieces instead.`,
            {composed: true, folder: `${folder}/`}
          );
          return;
        }
        if (ctx.query['shadow'] !== 'allow') {
          sendError(
            ctx.res,
            409,
            'shadow_conflict',
            `creating ${path} would shadow the atomized folder ${folder}/ — GET would stop composing the folder and serve this file instead. Write pieces into the folder, or pass ?shadow=allow to create the file deliberately.`,
            {folder: `${folder}/`}
          );
          return;
        }
      }
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
    const agentStale = new SuggestionFiler(deps.db, 'agent_enrichment_stale');
    const tagSuggestion = new SuggestionFiler(deps.db, 'tag_suggestion');
    const archiveCandidate = new SuggestionFiler(deps.db, 'archive_candidate');
    const existing = records.getByPath(path);

    let parsed: ReturnType<typeof parseWriteRequest>;
    try {
      parsed = parseWriteRequest(rawBody, ctx.req.headers['content-type']);
    } catch (err) {
      if (err instanceof WriterError) {
        sendError(ctx.res, err.status, err.code, err.message, err.details);
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
        // Same YAML-syntax guard the writer applies downstream — without it
        // a malformed FM block on a `?check=true` PUT throws past the
        // handler as a 500 instead of the writer's 400.
        let fm: ReturnType<typeof parseFrontmatter>;
        try {
          fm = parseFrontmatter(parsed.markdown);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendError(
            ctx.res,
            400,
            'invalid_yaml',
            `invalid YAML in frontmatter: ${msg}. Wrap multi-line strings in double quotes, use a folded block scalar (\`key: >-\`), or PUT with Content-Type: application/json to skip YAML parse.`
          );
          return;
        }
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
    const ifMatch = ctx.req.headers['if-match'];
    let etag: string;
    try {
      const result =
        parsed.kind === 'json'
          ? writeSplitRecordToDisk({
              filePath: path,
              existing,
              frontmatter: parsed.frontmatter,
              body: parsed.body,
              vaultDataPath: deps.vaultDataPath,
              ...(typeof ifMatch === 'string' ? {ifMatch} : {})
            })
          : writeRecordToDisk({
              filePath: path,
              existing,
              requestMarkdown: parsed.markdown,
              vaultDataPath: deps.vaultDataPath,
              ...(typeof ifMatch === 'string' ? {ifMatch} : {})
            });
      absolutePath = result.absolutePath;
      etag = result.etag;
    } catch (err) {
      if (err instanceof WriterError) {
        sendError(ctx.res, err.status, err.code, err.message, err.details);
        return;
      }
      throw err;
    }

    const {recordId} = importFile(records, path, absolutePath, undefined, {
      tags,
      agentStale,
      tagSuggestion,
      archiveCandidate
    });
    // Scoped edge pass so an FM `edges:` override settles its edge_type
    // suggestion on the write itself, not at the next watcher/reindex pass.
    buildEdges(deps.db, {vaultRoot: deps.vaultDataPath, scope: new Set([recordId])});
    // A create adds a path the cached wikilink resolver doesn't know.
    if (!existing) deps.resolverCache.invalidate();
    sendNoContent(ctx.res, {ETag: `"${etag}"`});
  };

interface EditBody {
  path?: unknown;
  op?: unknown;
  text?: unknown;
  from?: unknown;
  to?: unknown;
  all?: unknown;
}

/**
 * POST /vault/edit — atomic server-side body edit: the read-modify-write
 * primitive that retires the client-side GET → transform → ETag'd-PUT
 * ceremony for running-file updates (queue item moves, archive ship
 * reports, decisions sections). Request body, one op per call:
 *
 *   {path, op: "append", text}
 *   {path, op: "replace", from, to, all?}
 *
 * Semantics mirror claude-config's `vault-put` exactly (the established
 * client idiom this replaces): append collapses trailing whitespace to a
 * single newline before the fragment; replace is ASSERTED — an absent
 * `from` is a 409, an ambiguous one without `all: true` is a 409 carrying
 * the count — never a silent no-op (the curly-vs-straight-apostrophe bug
 * class). Frontmatter rides verbatim from disk through the standard write
 * path (`updated` re-stamped; enrichment staleness filed downstream); FM
 * changes stay on PUT / PATCH. Editing requires an existing on-disk file —
 * 404 otherwise, with a composed atomized view pointed at its pieces. No
 * If-Match: the server holds the document, so the RMW is atomic within the
 * single-threaded process — that is the point of the primitive. Returns
 * 200 `{path, etag, replaced?}`.
 */
export const editVaultHandler =
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
      sendError(ctx.res, 400, 'bad_request', 'body must be JSON');
      return;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendError(ctx.res, 400, 'bad_request', 'body must be an object: {path, op, ...}');
      return;
    }
    const req = parsed as EditBody;

    const path = typeof req.path === 'string' ? req.path : '';
    if (path.length === 0) {
      sendError(ctx.res, 400, 'invalid_path', 'path is required');
      return;
    }
    if (!path.endsWith('.md')) {
      sendError(ctx.res, 400, 'invalid_path', 'only .md files are supported');
      return;
    }
    if (req.op !== 'append' && req.op !== 'replace') {
      sendError(ctx.res, 400, 'bad_request', 'op must be "append" or "replace"');
      return;
    }
    if (req.op === 'append' && (typeof req.text !== 'string' || req.text.length === 0)) {
      sendError(ctx.res, 400, 'bad_request', 'append requires a non-empty string `text`');
      return;
    }
    if (req.op === 'replace') {
      if (typeof req.from !== 'string' || req.from.length === 0) {
        sendError(ctx.res, 400, 'bad_request', 'replace requires a non-empty string `from`');
        return;
      }
      if (typeof req.to !== 'string') {
        sendError(ctx.res, 400, 'bad_request', 'replace requires a string `to`');
        return;
      }
      if (req.all !== undefined && typeof req.all !== 'boolean') {
        sendError(ctx.res, 400, 'bad_request', '`all` must be a boolean');
        return;
      }
    }

    const abs = safePathOrError(deps.vaultDataPath, path, ctx.res);
    if (abs === null) return;
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      const folder = path.slice(0, -'.md'.length);
      if (existsSync(join(abs.slice(0, -'.md'.length), '_about.md'))) {
        sendError(
          ctx.res,
          409,
          'composed_view',
          `no file exists at ${path} — it is composed on demand from the atomized folder ${folder}/. Edit the folder's pieces instead.`,
          {composed: true, folder: `${folder}/`}
        );
        return;
      }
      sendError(ctx.res, 404, 'not_found', `no file at ${path} — edit cannot create documents`);
      return;
    }

    const {data: onDiskFm, body} = parseFrontmatter(readFileSync(abs, 'utf8'));

    let edited: string;
    let replaced: number | undefined;
    if (req.op === 'append') {
      edited = body.replace(/\s*$/, '\n') + (req.text as string);
    } else {
      const from = req.from as string;
      const count = body.split(from).length - 1;
      if (count === 0) {
        sendError(
          ctx.res,
          409,
          'replace_assert_failed',
          `replace target not found in ${path}:\n${from.slice(0, 200)}`,
          {occurrences: 0}
        );
        return;
      }
      if (count > 1 && req.all !== true) {
        sendError(
          ctx.res,
          409,
          'replace_assert_failed',
          `replace target occurs ${count} times in ${path} — pass all: true to replace every occurrence:\n${from.slice(0, 200)}`,
          {occurrences: count}
        );
        return;
      }
      const to = req.to as string;
      // Function replacer: a string replacement would interpret $-patterns.
      edited = req.all === true ? body.split(from).join(to) : body.replace(from, () => to);
      replaced = req.all === true ? count : 1;
    }

    // FM rides verbatim, minus null-valued keys: YAML empty values parse to
    // null, which the writer's wipe-guard rejects in *request* position — but
    // the merge restores them from the on-disk FM unchanged, so dropping them
    // here preserves the document exactly.
    const requestFm: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(onDiskFm)) {
      if (value !== null) requestFm[key] = value;
    }

    const {records} = deps;
    const existing = records.getByPath(path);
    let etag: string;
    try {
      const result = writeSplitRecordToDisk({
        filePath: path,
        existing,
        frontmatter: requestFm,
        body: edited,
        vaultDataPath: deps.vaultDataPath
      });
      etag = result.etag;
    } catch (err) {
      if (err instanceof WriterError) {
        sendError(ctx.res, err.status, err.code, err.message, err.details);
        return;
      }
      throw err;
    }

    const {recordId} = importFile(records, path, abs, undefined, {
      tags: new TagsImporter(deps.db),
      agentStale: new SuggestionFiler(deps.db, 'agent_enrichment_stale'),
      tagSuggestion: new SuggestionFiler(deps.db, 'tag_suggestion'),
      archiveCandidate: new SuggestionFiler(deps.db, 'archive_candidate')
    });
    buildEdges(deps.db, {vaultRoot: deps.vaultDataPath, scope: new Set([recordId])});

    sendJson(ctx.res, 200, {
      path,
      etag,
      ...(replaced !== undefined ? {replaced} : {})
    });
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

interface SupersedeBody {
  old_path?: unknown;
  new_path?: unknown;
  frontmatter?: unknown;
  body?: unknown;
}

/**
 * POST /vault/supersede — replace a note with a successor, archiving the
 * superseded one (decision 2026-06-11: archived, not tombstoned in place).
 *
 * Body: `{old_path, new_path?, frontmatter, body}` — the new note's content
 * in the standard JSON write shape. `new_path` defaults to `old_path`
 * (supersede-in-place): the old note moves out first, the successor takes
 * over its path, and inbound wikilinks naturally resolve to the
 * replacement while the archived copy stays reachable through the typed
 * edge.
 *
 * Steps, validation-first so a doomed request mutates nothing:
 *   1. Validate the payload (writer pre-flight), resolve all paths, check
 *      collisions: old must exist (disk + record), a distinct `new_path`
 *      and the archive slot must both be free.
 *   2. Move old → `<dir>/archive/<YYYY>/<name>` via the record-preserving
 *      rename (same mechanics as `/vault/move` — edges, embeddings, and
 *      suggestions survive), then stamp its FM `status: superseded`.
 *   3. Write the new note with a `supersedes` edge to the archived path
 *      merged into its `edges:` map (caller-provided edges are preserved).
 *
 * Edge materialization in the DB happens on the next watcher drain /
 * reindex, like every FM-declared edge; the FM is authoritative
 * immediately. Returns 200 `{old: {path, record_id}, new: {path,
 * record_id, etag}}`.
 */
export const supersedeVaultHandler =
  (deps: VaultDeps): Handler =>
  async ctx => {
    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }
    let parsed: SupersedeBody;
    try {
      const obj = JSON.parse(raw) as unknown;
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        sendError(ctx.res, 400, 'bad_request', 'request body must be a JSON object');
        return;
      }
      parsed = obj as SupersedeBody;
    } catch {
      sendError(ctx.res, 400, 'invalid_json', 'request body must be JSON');
      return;
    }

    const oldPath = parsed.old_path;
    if (typeof oldPath !== 'string' || !oldPath.endsWith('.md')) {
      sendError(ctx.res, 400, 'invalid_path', '`old_path` must be a .md file path');
      return;
    }
    if (parsed.new_path !== undefined && typeof parsed.new_path !== 'string') {
      sendError(ctx.res, 400, 'invalid_path', '`new_path` must be a string when provided');
      return;
    }
    const newPath = parsed.new_path ?? oldPath;
    if (!newPath.endsWith('.md')) {
      sendError(ctx.res, 400, 'invalid_path', '`new_path` must be a .md file path');
      return;
    }
    if (
      parsed.frontmatter === null ||
      typeof parsed.frontmatter !== 'object' ||
      Array.isArray(parsed.frontmatter) ||
      typeof parsed.body !== 'string'
    ) {
      sendError(
        ctx.res,
        400,
        'invalid_json_shape',
        'new note content must be `{frontmatter: object, body: string}` — both fields required'
      );
      return;
    }
    const newFm = parsed.frontmatter as Record<string, unknown>;
    const newBody = parsed.body;

    // ── Validation phase: nothing below this comment mutates until every
    // check has passed. The writer pre-flight covers enum/auto-managed/
    // double-FM failures that would otherwise surface mid-mutation.
    try {
      validateWritePayload(newFm, newBody);
    } catch (err) {
      if (err instanceof WriterError) {
        sendError(ctx.res, err.status, err.code, err.message, err.details);
        return;
      }
      throw err;
    }

    const oldAbs = safePathOrError(deps.vaultDataPath, oldPath, ctx.res);
    if (oldAbs === null) return;
    const newAbs = safePathOrError(deps.vaultDataPath, newPath, ctx.res);
    if (newAbs === null) return;

    const {records} = deps;
    const oldRecord = records.getByPath(oldPath);
    if (!oldRecord || !existsSync(oldAbs) || !statSync(oldAbs).isFile()) {
      sendError(ctx.res, 404, 'not_found', `no note at ${oldPath}`);
      return;
    }
    if (newPath !== oldPath && (existsSync(newAbs) || records.getByPath(newPath))) {
      sendError(ctx.res, 409, 'conflict', `new_path already exists: ${newPath}`);
      return;
    }

    const year = new Date().getFullYear();
    const oldDir = dirname(oldPath);
    const oldName = basename(oldPath);
    const archivePath = `${oldDir === '.' ? '' : `${oldDir}/`}archive/${year}/${oldName}`;
    const archiveAbs = safePathOrError(deps.vaultDataPath, archivePath, ctx.res);
    if (archiveAbs === null) return;
    if (existsSync(archiveAbs) || records.getByPath(archivePath)) {
      sendError(ctx.res, 409, 'conflict', `archive slot already occupied: ${archivePath}`);
      return;
    }

    // ── Mutation phase.
    const tags = new TagsImporter(deps.db);
    const filers = {
      tags,
      agentStale: new SuggestionFiler(deps.db, 'agent_enrichment_stale'),
      tagSuggestion: new SuggestionFiler(deps.db, 'tag_suggestion'),
      archiveCandidate: new SuggestionFiler(deps.db, 'archive_candidate')
    };

    // 1. Archive the old note, record_id preserved.
    mkdirSync(dirname(archiveAbs), {recursive: true});
    renameSync(oldAbs, archiveAbs);
    records.updateFilePath(oldRecord.recordId, archivePath);

    // 2. Stamp the archived note `status: superseded` (FM merge keeps the
    //    rest) and re-import it.
    const archivedFm = parseFrontmatter(readFileSync(archiveAbs, 'utf8'));
    writeSplitRecordToDisk({
      filePath: archivePath,
      existing: records.getById(oldRecord.recordId),
      frontmatter: {status: 'superseded'},
      body: archivedFm.body,
      vaultDataPath: deps.vaultDataPath
    });
    const archived = importFile(records, archivePath, archiveAbs, undefined, filers);

    // 3. Write the successor with the supersession wired in. Edges are
    //    backed by BODY wikilinks (the FM `edges:` map only retypes body
    //    links — an FM entry with no backing link produces no edge), so the
    //    typed edge comes from an appended footer whose `Supersedes [[…]]`
    //    phrasing the wikilink classifier types natively. The FM entry is
    //    added alongside to pin the type and document intent in
    //    frontmatter. Found live 2026-06-11: the FM-only variant produced
    //    edges=0 on the drain.
    const callerEdges =
      newFm['edges'] && typeof newFm['edges'] === 'object' && !Array.isArray(newFm['edges'])
        ? (newFm['edges'] as Record<string, unknown>)
        : {};
    const archiveEdgeKey = archivePath.slice(0, -'.md'.length);
    const footer = `> Supersedes [[${archiveEdgeKey}]].`;
    const result = writeSplitRecordToDisk({
      filePath: newPath,
      existing: null,
      frontmatter: {...newFm, edges: {...callerEdges, [archiveEdgeKey]: 'supersedes'}},
      body: `${newBody.replace(/\s+$/, '')}\n\n${footer}\n`,
      vaultDataPath: deps.vaultDataPath
    });
    const successor = importFile(records, newPath, result.absolutePath, undefined, filers);
    // Scoped edge pass: materializes the successor's `supersedes` edge (and
    // settles any pending edge_type suggestions) in the same request instead
    // of waiting for the watcher drain.
    buildEdges(deps.db, {
      vaultRoot: deps.vaultDataPath,
      scope: new Set([archived.recordId, successor.recordId])
    });

    // Two path-set changes (old moved, new created).
    deps.resolverCache.invalidate();

    const newRecord = records.getByPath(newPath);
    sendJson(ctx.res, 200, {
      old: {path: archivePath, record_id: oldRecord.recordId},
      new: {path: newPath, record_id: newRecord?.recordId ?? null, etag: result.etag}
    });
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
