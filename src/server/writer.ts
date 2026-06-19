import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {parseFrontmatter, serializeFrontmatter} from '../markdown/frontmatter.ts';
import {contentHash} from '../util/hash.ts';
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
 * `last_referenced`, `decay_score`, and `modified_at` are reflection-time
 * fields (`modified_at` is stamped by the upsert at import; see schema 0012).
 */
export const AUTO_MANAGED_KEYS: ReadonlySet<string> = new Set([
  'record_id',
  'content_hash',
  'last_referenced',
  'decay_score',
  'modified_at'
]);

/**
 * Frontmatter keys the API silently drops from request input. The indexer is
 * authoritative for these — `created` is preserved from disk/record, `updated`
 * is force-stamped to now. Round-trip writers (read → modify → write) can leave
 * them in the payload without 400-ing.
 */
export const INDEXER_OVERRIDE_KEYS: ReadonlySet<string> = new Set(['created', 'updated']);

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
  /** Structured payload merged into the error envelope (e.g. current_etag on 412). */
  readonly details: Record<string, unknown> | undefined;
  constructor(message: string, code: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = 'WriterError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Document ETag: sha256 hex over the exact file bytes (frontmatter + body as
 * served by `GET /vault/{path}`). Covers FM-only edits, which the indexed
 * `content_hash` (body + agent summary) does not.
 */
export const documentEtag = (documentBytes: string): string => contentHash(documentBytes);

/**
 * Parse an `If-Match` header into its entity-tag values: handles the
 * comma-separated list form, optional `W/` weak prefixes (treated as their
 * opaque value — we never emit weak tags), surrounding quotes, and the `*`
 * wildcard. Bare unquoted hashes are accepted for caller convenience.
 */
export const parseIfMatch = (header: string): string[] =>
  header
    .split(',')
    .map(v => v.trim())
    .filter(v => v.length > 0)
    .map(v => (v.startsWith('W/') ? v.slice(2) : v))
    .map(v => (v.startsWith('"') && v.endsWith('"') && v.length >= 2 ? v.slice(1, -1) : v));

export interface WriteOptions {
  /** Vault-relative path. Source of truth for where to write. */
  filePath: string;
  requestMarkdown: string;
  vaultDataPath: string;
  /** Existing record, when replacing. Provides `created` fallback if file is
   *  off-disk. Null when creating a new file. */
  existing: VaultRecord | null;
  /**
   * Raw `If-Match` header value (optimistic concurrency, opt-in). When set,
   * the write proceeds only if the current on-disk document's ETag matches
   * one of the listed tags (`*` matches any existing document); otherwise
   * 412 with `details.current_etag` for the re-read-merge-retry loop.
   * Absent header → last-writer-wins, the pre-existing contract.
   */
  ifMatch?: string;
  now?: string;
}

export interface WriteSplitOptions {
  filePath: string;
  /** Frontmatter as a parsed object — bypasses the YAML parse step entirely. */
  frontmatter: Record<string, unknown>;
  /** Markdown body (no leading `---` block). */
  body: string;
  vaultDataPath: string;
  existing: VaultRecord | null;
  /** Raw `If-Match` header value — see {@link WriteOptions.ifMatch}. */
  ifMatch?: string;
  now?: string;
}

export type ParsedWriteRequest =
  | {kind: 'markdown'; markdown: string}
  | {kind: 'json'; frontmatter: Record<string, unknown>; body: string};

/**
 * Decode a PUT request body based on `Content-Type`:
 *   - `text/markdown` (or unset, the default): treat the raw body as the
 *     classic `---\nFM\n---\nbody` blob; the writer parses YAML downstream.
 *   - `application/json`: parse as `{frontmatter: object, body: string}`
 *     and skip YAML parse — the recommended path for programmatic callers.
 *
 * Throws `WriterError` (400) when the body's shape is wrong for the chosen
 * Content-Type.
 */
export const parseWriteRequest = (
  rawBody: string,
  contentType: string | undefined
): ParsedWriteRequest => {
  const ct = (contentType ?? '').split(';')[0]?.trim();
  if (ct === 'application/json') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new WriterError(`request body is not valid JSON: ${msg}`, 'invalid_json', 400);
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>)['frontmatter'] !== 'object' ||
      (parsed as Record<string, unknown>)['frontmatter'] === null ||
      Array.isArray((parsed as Record<string, unknown>)['frontmatter']) ||
      typeof (parsed as Record<string, unknown>)['body'] !== 'string'
    ) {
      throw new WriterError(
        'JSON body must be `{frontmatter: object, body: string}` — both fields required',
        'invalid_json_shape',
        400
      );
    }
    const obj = parsed as {frontmatter: Record<string, unknown>; body: string};
    return {kind: 'json', frontmatter: obj.frontmatter, body: obj.body};
  }
  return {kind: 'markdown', markdown: rawBody};
};

/**
 * Validate a write payload's frontmatter + body without touching disk.
 * Throws `WriterError` (400) on violations. `writeSplitRecordToDisk` runs
 * this after the If-Match gate; multi-step handlers (e.g. supersede) call
 * it as a pre-flight so a doomed request fails *before* any disk mutation.
 *
 * Checks, in order:
 * - Body must not begin with another frontmatter-shaped block
 *   (`---\n…\n---`): the caller almost certainly appended the original
 *   file's full content to a new FM block — this exact failure mode wiped
 *   15 files on 2026-05-01 (a sub-agent's PUT-helper bug).
 * - Auto-managed keys (`record_id`, `content_hash`, …) are rejected.
 * - Closed-enum fields (`status`, `type`, `priority`): canonical values
 *   and known aliases pass; anything else 400s so authoring typos surface
 *   at the boundary rather than silently coercing to a default.
 */
export const validateWritePayload = (
  frontmatter: Record<string, unknown>,
  body: string
): void => {
  if (looksLikeAnotherFmBlock(body)) {
    throw new WriterError(
      'request body begins with another frontmatter-style block (`---\\n…\\n---`) — almost certainly a malformed PUT (the caller likely appended the original file to a new FM block, which would silently destroy the body). Construct the PUT body as `---\\n<merged FM>\\n---\\n<body>` with a single FM block.',
      'malformed_double_frontmatter',
      400
    );
  }

  const violations = Object.keys(frontmatter).filter(k => AUTO_MANAGED_KEYS.has(k));
  if (violations.length > 0) {
    throw new WriterError(
      `frontmatter keys are auto-managed and cannot be set on write: ${violations.join(', ')}`,
      'frontmatter_auto_managed',
      400
    );
  }

  const statusErr = validateClosedEnum(
    'status',
    frontmatter['status'],
    STATUS_SET,
    STATUS_ALIAS_KEYS
  );
  if (statusErr) throw new WriterError(statusErr, 'invalid_enum_value', 400);
  const typeErr = validateClosedEnum('type', frontmatter['type'], TYPE_SET, new Set());
  if (typeErr) throw new WriterError(typeErr, 'invalid_enum_value', 400);
  const priorityErr = validatePriority(frontmatter['priority']);
  if (priorityErr) throw new WriterError(priorityErr, 'invalid_enum_value', 400);
};

export interface WriteResult {
  /** Absolute path on disk where the file was written. */
  absolutePath: string;
  /** Final composed frontmatter object. */
  frontmatter: Record<string, unknown>;
  /** Final body (post-frontmatter). */
  body: string;
  /** ETag of the bytes just written — returned to callers for chained conditional writes. */
  etag: string;
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
    // double-quoting the value, using a folded block scalar (`key: >-`),
    // or sending frontmatter as JSON via `Content-Type: application/json`
    // — that path bypasses YAML parse entirely.
    const msg = err instanceof Error ? err.message : String(err);
    throw new WriterError(
      `invalid YAML in frontmatter: ${msg}. Wrap multi-line strings in double quotes, use a folded block scalar (\`key: >-\`), or PUT with Content-Type: application/json to skip YAML parse.`,
      'invalid_yaml',
      400
    );
  }

  return writeSplitRecordToDisk({
    filePath,
    frontmatter: requestFm,
    body: requestBody,
    vaultDataPath,
    existing,
    ...(opts.ifMatch !== undefined ? {ifMatch: opts.ifMatch} : {}),
    ...(opts.now !== undefined ? {now: opts.now} : {})
  });
};

/**
 * Variant of `writeRecordToDisk` that takes already-split frontmatter (as a
 * parsed object) + body. Skips the YAML *parse* step — `yaml.stringify` on
 * disk handles all the quoting concerns automatically (verified across
 * colon-space, multi-line, leading-`@`/`*`/`-`/`?`, hex-shadow, bool-shadow,
 * and date-shadow strings). Same downstream merge / validate / write path
 * as `writeRecordToDisk`.
 *
 * Exposed via `PUT /vault/{path}` with `Content-Type: application/json` and
 * body `{frontmatter: {...}, body: "..."}` — the recommended path for
 * programmatic callers (agents, UI) that already have an FM object in hand.
 */
export const writeSplitRecordToDisk = (opts: WriteSplitOptions): WriteResult => {
  const {filePath, existing, frontmatter, body, vaultDataPath} = opts;
  const now = opts.now ?? new Date().toISOString();

  const absolutePath = ensureSafePath(vaultDataPath, filePath);

  // Read the current document once — the If-Match precondition hashes it,
  // and the frontmatter merge below reuses the same bytes.
  const onDisk = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : null;

  // Optimistic-concurrency gate (opt-in via the If-Match header). The ETag
  // is sha256 over the whole document bytes, so FM-only edits invalidate it
  // too. A 412 carries the current ETag so the caller can re-read, re-merge,
  // and retry; no header preserves the last-writer-wins contract.
  if (opts.ifMatch !== undefined) {
    const expected = parseIfMatch(opts.ifMatch);
    if (onDisk === null) {
      throw new WriterError(
        'If-Match given but no document exists at this path — conditional writes cannot create files',
        'precondition_failed',
        412
      );
    }
    const current = documentEtag(onDisk);
    if (!expected.includes('*') && !expected.includes(current)) {
      throw new WriterError(
        `If-Match precondition failed: the document changed since it was read (current ETag "${current}"). Re-read, re-merge, and retry.`,
        'precondition_failed',
        412,
        {current_etag: current}
      );
    }
  }

  validateWritePayload(frontmatter, body);

  const requestFm = frontmatter;
  const requestBody = body;

  const sanitizedRequestFm: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(requestFm)) {
    if (!INDEXER_OVERRIDE_KEYS.has(k)) sanitizedRequestFm[k] = v;
  }

  let existingFm: Record<string, unknown> = {};
  if (onDisk !== null) {
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

  return {absolutePath, frontmatter: merged, body: requestBody, etag: documentEtag(out)};
};

export const composeRelativePath = (vaultRoot: string, abs: string): string =>
  relative(resolve(vaultRoot), resolve(abs));

/** Re-export join for handler convenience without importing node:path twice. */
export const joinVaultPath = (vaultRoot: string, ...rest: string[]): string =>
  join(vaultRoot, ...rest);
