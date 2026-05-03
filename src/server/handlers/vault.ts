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
import {
  AgentEnrichmentStaleFiler,
  ArchiveCandidateFiler,
  TagSuggestionFiler
} from '../../importer/file-suggestions.ts';
import {importFile} from '../../importer/import-file.ts';
import {TagsImporter} from '../../importer/import-tags.ts';
import {RecordsRepository} from '../../records/repository.ts';
import {readBodyText} from '../body.ts';
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
      const records = new RecordsRepository(deps.db);
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

/** PUT /vault/{path} — create or replace a file. */
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

    const records = new RecordsRepository(deps.db);
    const tags = new TagsImporter(deps.db);
    const agentStale = new AgentEnrichmentStaleFiler(deps.db);
    const tagSuggestion = new TagSuggestionFiler(deps.db);
    const archiveCandidate = new ArchiveCandidateFiler(deps.db);
    const existing = records.getByPath(path);

    let absolutePath: string;
    try {
      const parsed = parseWriteRequest(rawBody, ctx.req.headers['content-type']);
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
    const records = new RecordsRepository(deps.db);
    const existing = records.getByPath(path);

    if (!onDisk && !existing) {
      sendError(ctx.res, 404, 'not_found', `no file at ${path}`);
      return;
    }

    if (onDisk) unlinkSync(abs);
    if (existing) records.delete(existing.recordId);

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

    const records = new RecordsRepository(deps.db);
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

    sendNoContent(ctx.res);
  };
