import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {parseFrontmatter, serializeFrontmatter} from '../markdown/frontmatter.ts';
import type {VaultRecord} from '../records/types.ts';

/**
 * Frontmatter keys the API rejects on PUT/PATCH because they are DB-only.
 * Writes that include any of these → 400.
 *
 * `record_id` and `content_hash` come from DB identity, not user input.
 * `last_referenced` and `decay_score` are reflection-time fields.
 */
const AUTO_MANAGED_KEYS = new Set([
  'record_id',
  'content_hash',
  'last_referenced',
  'decay_score'
]);

/**
 * Frontmatter keys the API silently drops from request input. The indexer is
 * authoritative for these — `created` is preserved from disk/record, `updated`
 * is force-stamped to now. Round-trip writers (read → modify → write) can leave
 * them in the payload without 400-ing.
 */
const INDEXER_OVERRIDE_KEYS = new Set(['created', 'updated']);

export class WriterError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'WriterError';
    this.code = code;
    this.status = status;
  }
}

export interface WriteOptions {
  /** Vault-relative path. Source of truth for where to write. */
  filePath: string;
  requestMarkdown: string;
  vaultDataPath: string;
  /** Existing record, when replacing. Provides `created` fallback if file is
   *  off-disk. Null when creating a new file. */
  existing: VaultRecord | null;
  now?: string;
}

export interface WriteResult {
  /** Absolute path on disk where the file was written. */
  absolutePath: string;
  /** Final composed frontmatter object. */
  frontmatter: Record<string, unknown>;
  /** Final body (post-frontmatter). */
  body: string;
}

/**
 * Resolve a vault-relative path against `vaultRoot`. Rejects path traversal,
 * null bytes, and absolute paths that escape the root.
 */
export const ensureSafePath = (vaultRoot: string, filePath: string): string => {
  if (filePath.includes('\0')) throw new WriterError('invalid file path', 'invalid_path', 400);
  if (filePath.length === 0) throw new WriterError('empty file path', 'invalid_path', 400);
  const absRoot = resolve(vaultRoot);
  const absFile = resolve(absRoot, filePath);
  const rel = relative(absRoot, absFile);
  if (rel.startsWith('..') || resolve(absRoot, rel) !== absFile) {
    throw new WriterError('file_path escapes vault root', 'invalid_path', 400);
  }
  return absFile;
};

/**
 * Compose new frontmatter + body from a request, write to disk, return the
 * composed shape. Does NOT touch the DB — the caller re-imports the file
 * (which recomputes content_hash + updated and triggers re-embedding).
 *
 * Frontmatter merge precedence (highest first): the request's user-authored
 * keys, then on-disk frontmatter, then the existing record's fields, then
 * defaults. `updated` is always force-stamped to `now`. `created` is preserved
 * from disk/record, or stamped at first write.
 */
export const writeRecordToDisk = (opts: WriteOptions): WriteResult => {
  const {filePath, existing, requestMarkdown, vaultDataPath} = opts;
  const now = opts.now ?? new Date().toISOString();

  const absolutePath = ensureSafePath(vaultDataPath, filePath);

  const {data: requestFm, body: requestBody} = parseFrontmatter(requestMarkdown);

  const violations = Object.keys(requestFm).filter(k => AUTO_MANAGED_KEYS.has(k));
  if (violations.length > 0) {
    throw new WriterError(
      `frontmatter keys are auto-managed and cannot be set on write: ${violations.join(', ')}`,
      'frontmatter_auto_managed',
      400
    );
  }

  const sanitizedRequestFm: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(requestFm)) {
    if (!INDEXER_OVERRIDE_KEYS.has(k)) sanitizedRequestFm[k] = v;
  }

  let existingFm: Record<string, unknown> = {};
  if (existsSync(absolutePath)) {
    const onDisk = readFileSync(absolutePath, 'utf8');
    existingFm = parseFrontmatter(onDisk).data;
  } else if (existing) {
    existingFm = {
      title: '',
      type: existing.type,
      status: existing.status,
      priority: existing.priority,
      created: existing.created
    };
  }

  const merged: Record<string, unknown> = {...existingFm, ...sanitizedRequestFm};
  merged['updated'] = now.slice(0, 10);
  if (!('created' in merged)) {
    merged['created'] = existing ? existing.created.slice(0, 10) : now.slice(0, 10);
  }

  mkdirSync(dirname(absolutePath), {recursive: true});
  const out = serializeFrontmatter({data: merged, body: requestBody});
  writeFileSync(absolutePath, out, 'utf8');

  return {absolutePath, frontmatter: merged, body: requestBody};
};

export const composeRelativePath = (vaultRoot: string, abs: string): string =>
  relative(resolve(vaultRoot), resolve(abs));

/** Re-export join for handler convenience without importing node:path twice. */
export const joinVaultPath = (vaultRoot: string, ...rest: string[]): string =>
  join(vaultRoot, ...rest);
