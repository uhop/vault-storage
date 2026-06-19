import {readFile, stat} from 'node:fs/promises';
import {extname, join, resolve, sep} from 'node:path';
import {sendError} from '../responses.ts';
import type {Handler} from '../router.ts';

interface StaticDeps {
  /** Directory the handler serves files from. */
  rootDir: string;
  /** When the request is the root prefix (e.g. `/ui/`), serve this file. */
  indexFile?: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8'
};

const mimeFor = (path: string): string =>
  MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';

/**
 * Cheap, change-stable ETag from `<size>-<mtime-ms>` — no hash compute on
 * the hot path. Both file replacements and in-place edits change at least
 * one of size / mtime; the only ambiguous case (same-byte-count edit at
 * the exact recorded ms) is a non-issue in practice.
 */
const etagFor = (size: number, mtimeMs: number): string =>
  `"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`;

/**
 * Serve files from a directory under a route prefix.
 *
 * Supports If-None-Match → 304 so the browser can revalidate without
 * re-downloading. `Cache-Control: no-cache` keeps the cache useful while
 * forcing a freshness check (the 304 path is a few hundred bytes; full
 * download is the file size). Suitable for an unhashed deploy where we
 * want fresh-on-redeploy without long cache invalidation tails.
 */
export const staticHandler =
  (deps: StaticDeps): Handler =>
  async ctx => {
    const {rootDir, indexFile} = deps;
    const rel = ctx.params['path'] ?? '';
    const target = rel === '' || rel.endsWith('/') ? `${rel}${indexFile ?? ''}` : rel;
    if (!target) {
      sendError(ctx.res, 404, 'not_found', 'no such file');
      return;
    }

    const root = resolve(rootDir);
    const candidate = resolve(join(root, target));
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      sendError(ctx.res, 400, 'bad_request', 'path traversal rejected');
      return;
    }

    let info;
    try {
      info = await stat(candidate);
    } catch {
      sendError(ctx.res, 404, 'not_found', 'no such file');
      return;
    }
    if (!info.isFile()) {
      sendError(ctx.res, 404, 'not_found', 'no such file');
      return;
    }

    const etag = etagFor(info.size, info.mtimeMs);
    const reqEtag = ctx.req.headers['if-none-match'];
    if (reqEtag === etag) {
      ctx.res.writeHead(304, {
        ETag: etag,
        'Cache-Control': 'no-cache'
      });
      ctx.res.end();
      return;
    }

    const body = await readFile(candidate);
    ctx.res.writeHead(200, {
      'Content-Type': mimeFor(candidate),
      'Content-Length': body.byteLength.toString(),
      ETag: etag,
      'Cache-Control': 'no-cache'
    });
    ctx.res.end(body);
  };
