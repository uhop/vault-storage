import {existsSync, readFileSync, readdirSync, statSync, unlinkSync} from 'node:fs';
import type {ServerResponse} from 'node:http';
import {basename, join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {parseFrontmatter} from '../../markdown/frontmatter.ts';
import {importFile} from '../../importer/import-file.ts';
import {RecordsRepository} from '../../records/repository.ts';
import {readBodyText} from '../body.ts';
import {sendError, sendJson, sendNoContent, sendText} from '../responses.ts';
import type {Handler} from '../router.ts';
import {ensureSafePath, WriterError, writeRecordToDisk} from '../writer.ts';

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

    let requestMarkdown: string;
    try {
      requestMarkdown = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }

    const records = new RecordsRepository(deps.db);
    const existing = records.getByPath(path);

    let absolutePath: string;
    try {
      const result = writeRecordToDisk({
        filePath: path,
        existing,
        requestMarkdown,
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

    importFile(records, path, absolutePath);
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
