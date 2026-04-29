import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {parseFrontmatter, serializeFrontmatter} from '../markdown/frontmatter.ts';
import type {VaultRecord} from '../records/types.ts';

/**
 * Frontmatter keys the API rejects on PUT/PATCH because they are auto-managed
 * by the indexer. Writes that include any of these → 400.
 *
 * `record_id` and `content_hash` come from DB identity, not user input.
 * `created` is set on first import; preserved on update.
 * `updated`, `last_referenced`, `decay_score` are reflection-time fields.
 */
const AUTO_MANAGED_KEYS = new Set([
  'record_id',
  'content_hash',
  'created',
  'updated',
  'last_referenced',
  'decay_score'
]);

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
  existing: VaultRecord;
  requestMarkdown: string;
  vaultDataPath: string;
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

const ensureSafePath = (vaultRoot: string, filePath: string): string => {
  if (filePath.includes('\0')) throw new WriterError('invalid file path', 'invalid_path', 400);
  const absRoot = resolve(vaultRoot);
  const absFile = resolve(absRoot, filePath);
  const rel = relative(absRoot, absFile);
  if (rel.startsWith('..') || resolve(absRoot, rel) !== absFile) {
    throw new WriterError(
      'file_path escapes vault root',
      'invalid_path',
      400
    );
  }
  return absFile;
};

/**
 * Compose new frontmatter + body from a request, write to disk, return the
 * composed shape. Does NOT touch the DB — the caller re-imports the file
 * (which recomputes content_hash + updated and triggers re-embedding).
 */
export const writeRecordToDisk = (opts: WriteOptions): WriteResult => {
  const {existing, requestMarkdown, vaultDataPath} = opts;
  const now = opts.now ?? new Date().toISOString();

  const absolutePath = ensureSafePath(vaultDataPath, existing.filePath);

  const {data: requestFm, body: requestBody} = parseFrontmatter(requestMarkdown);

  const violations = Object.keys(requestFm).filter(k => AUTO_MANAGED_KEYS.has(k));
  if (violations.length > 0) {
    throw new WriterError(
      `frontmatter keys are auto-managed and cannot be set on write: ${violations.join(', ')}`,
      'frontmatter_auto_managed',
      400
    );
  }

  // Existing file may not be on disk yet (e.g., DB seeded but file deleted);
  // fall back to a synthesized frontmatter from the existing record in that case.
  let existingFm: Record<string, unknown>;
  if (existsSync(absolutePath)) {
    const onDisk = readFileSync(absolutePath, 'utf8');
    existingFm = parseFrontmatter(onDisk).data;
  } else {
    existingFm = {
      title: '',
      type: existing.type,
      status: existing.status,
      priority: existing.priority,
      created: existing.created
    };
  }

  // Merge: keep existing keys, override with request keys, force `updated: now`.
  // `created` is preserved from the existing frontmatter (or the existing record
  // if disk has none) and never overridden by the request — request_fm cannot
  // contain it (caught by AUTO_MANAGED_KEYS above).
  const merged: Record<string, unknown> = {...existingFm, ...requestFm};
  merged['updated'] = now.slice(0, 10); // ISO date (YYYY-MM-DD), matching vault convention
  if (!('created' in merged)) merged['created'] = existing.created.slice(0, 10);

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
