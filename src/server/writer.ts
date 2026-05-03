import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {parseFrontmatter, serializeFrontmatter} from '../markdown/frontmatter.ts';
import {
  PRIORITY_ALIASES,
  RECORD_STATUSES,
  RECORD_TYPES,
  STATUS_ALIASES,
  type VaultRecord
} from '../records/types.ts';

/**
 * Frontmatter keys the API rejects on PUT/PATCH because they are DB-only.
 * Writes that include any of these → 400.
 *
 * `record_id` and `content_hash` come from DB identity, not user input.
 * `last_referenced` and `decay_score` are reflection-time fields.
 */
const AUTO_MANAGED_KEYS = new Set(['record_id', 'content_hash', 'last_referenced', 'decay_score']);

/**
 * Frontmatter keys the API silently drops from request input. The indexer is
 * authoritative for these — `created` is preserved from disk/record, `updated`
 * is force-stamped to now. Round-trip writers (read → modify → write) can leave
 * them in the payload without 400-ing.
 */
const INDEXER_OVERRIDE_KEYS = new Set(['created', 'updated']);

const STATUS_SET: ReadonlySet<string> = new Set(RECORD_STATUSES);
const TYPE_SET: ReadonlySet<string> = new Set(RECORD_TYPES);
const STATUS_ALIAS_KEYS: ReadonlySet<string> = new Set(Object.keys(STATUS_ALIASES));
const PRIORITY_ALIAS_KEYS: ReadonlySet<string> = new Set(Object.keys(PRIORITY_ALIASES));

/**
 * Validate a single closed-enum FM field. Pass-through if the value is
 * canonical or a known alias (preserves round-trip ergonomics on legacy
 * FMs); reject typos with a clear error so authoring mistakes surface
 * at the API boundary rather than silently coercing to a default.
 *
 * Returns null on accept; an error string when the value should 400.
 */
const validateClosedEnum = (
  field: 'status' | 'type',
  value: unknown,
  canonical: ReadonlySet<string>,
  aliases: ReadonlySet<string>
): string | null => {
  if (value === undefined || value === null) return null; // missing → indexer default
  if (typeof value !== 'string') return `${field} must be a string`;
  if (canonical.has(value)) return null;
  if (aliases.has(value)) return null;
  const expected = [...canonical].sort().join(', ');
  const aliasNote = aliases.size > 0 ? ` (or aliases: ${[...aliases].sort().join(', ')})` : '';
  return `unknown ${field} value '${value}' — expected one of: ${expected}${aliasNote}`;
};

const validatePriority = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return null;
  if (typeof value === 'string' && PRIORITY_ALIAS_KEYS.has(value)) return null;
  if (typeof value === 'string') {
    return `unknown priority alias '${value}' — expected an integer or one of: ${[...PRIORITY_ALIAS_KEYS].sort().join(', ')}`;
  }
  return 'priority must be an integer or a named alias';
};

/**
 * Detect a body that itself begins with a frontmatter-shaped opening:
 * `---\n…\n---` within the first ~50 lines. Used to reject malformed
 * PUTs whose body is the original full-file content (FM + body) appended
 * to a new FM block — a common helper-script bug that would silently
 * destroy the body. A standalone `---` thematic break at the body's
 * start is allowed (no closing `---` line nearby).
 */
const looksLikeAnotherFmBlock = (body: string): boolean => {
  if (!body.startsWith('---\n')) return false;
  const lines = body.split('\n');
  for (let i = 1; i < Math.min(lines.length, 51); i++) {
    if (lines[i] === '---') return true;
  }
  return false;
};

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

  let requestFm: Record<string, unknown>;
  let requestBody: string;
  try {
    ({data: requestFm, body: requestBody} = parseFrontmatter(requestMarkdown));
  } catch (err) {
    // `yaml.parse` throws `YAMLParseError` on syntactically invalid
    // frontmatter — most commonly an unquoted multi-line plain scalar
    // containing `: ` (colon-space), which YAML reads as starting a nested
    // mapping. Surface the parser's own diagnostic (line/column) as a 400
    // instead of letting it propagate to a 500. Callers can fix by
    // double-quoting the value or using a folded block scalar (`key: >-`).
    const msg = err instanceof Error ? err.message : String(err);
    throw new WriterError(
      `invalid YAML in frontmatter: ${msg}. Wrap multi-line strings in double quotes or use a folded block scalar (\`key: >-\`) to avoid colon-space ambiguity.`,
      'invalid_yaml',
      400
    );
  }

  // Defense against malformed PUTs: when a body itself begins with a
  // frontmatter-shaped opening (`---\n…\n---\n`), the caller almost
  // certainly appended the original file's full content (its own FM + body)
  // to a new FM block. parseFrontmatter would still grab the first block
  // as FM, the writer would replace the body with the leftover, and the
  // result on disk would be two FM blocks with no body. We saw this exact
  // failure mode wipe 15 files on 2026-05-01 (a sub-agent's PUT-helper
  // bug). Reject at the boundary instead of silently destroying content.
  if (looksLikeAnotherFmBlock(requestBody)) {
    throw new WriterError(
      'request body begins with another frontmatter-style block (`---\\n…\\n---`) — almost certainly a malformed PUT (the caller likely appended the original file to a new FM block, which would silently destroy the body). Construct the PUT body as `---\\n<merged FM>\\n---\\n<body>` with a single FM block.',
      'malformed_double_frontmatter',
      400
    );
  }

  const violations = Object.keys(requestFm).filter(k => AUTO_MANAGED_KEYS.has(k));
  if (violations.length > 0) {
    throw new WriterError(
      `frontmatter keys are auto-managed and cannot be set on write: ${violations.join(', ')}`,
      'frontmatter_auto_managed',
      400
    );
  }

  // Closed-enum field validation: status, type, priority. Canonical values
  // and known aliases pass; anything else 400s so authoring typos surface
  // at the boundary rather than silently coercing to the default.
  const statusErr = validateClosedEnum(
    'status',
    requestFm['status'],
    STATUS_SET,
    STATUS_ALIAS_KEYS
  );
  if (statusErr) throw new WriterError(statusErr, 'invalid_enum_value', 400);
  const typeErr = validateClosedEnum('type', requestFm['type'], TYPE_SET, new Set());
  if (typeErr) throw new WriterError(typeErr, 'invalid_enum_value', 400);
  const priorityErr = validatePriority(requestFm['priority']);
  if (priorityErr) throw new WriterError(priorityErr, 'invalid_enum_value', 400);

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
