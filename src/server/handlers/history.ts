import {existsSync, statSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {buildEdges} from '../../importer/build-edges.ts';
import {importFile} from '../../importer/import-file.ts';
import {fullImportOptions} from '../../importer/import-options.ts';
import {setLastIndexedCommit} from '../../maintenance/incremental-reindex.ts';
import type {RecordsRepository} from '../../records/repository.ts';
import {getCurrentHead, gitFailure, isGitRepo, runGit} from '../../util/git.ts';
import {readBodyText} from '../body.ts';
import {parsePagination, rejectUnknownParams, NO_QUERY_PARAMS} from '../query.ts';
import type {ResolverCache} from '../resolver-cache.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';
import {requestTags, type TagChecker, type UnknownTagRef} from '../tag-check.ts';
import {ensureSafePath, parseWriteRequest, WriterError, writeRecordToDisk} from '../writer.ts';
import {clearWriters, writersOf} from '../writers.ts';

export const SHA_RE = /^[0-9a-f]{7,40}$/;

// A request waits on these; the sync loop's five-minute ceiling is for the loop.
const HISTORY_TIMEOUT_MS = 10_000;

const CHANGES: Record<string, string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'modified'
};

export interface Version {
  sha: string;
  date: string;
  /** The commit's author: the writer of a named key, or the configured author (D136). */
  author: string;
  subject: string;
  /** The note's path at that commit; `--follow` crosses renames. */
  path: string;
  change: string;
}

const git = (vaultDataPath: string, args: string[]) =>
  runGit(vaultDataPath, ['-c', 'core.quotePath=false', ...args], {
    timeoutMs: HISTORY_TIMEOUT_MS
  });

/**
 * One page of a note's committed versions, newest first, and whether it is the
 * last; from `rev` back when given, where `path` is the note's path at `rev`.
 */
export const listVersions = async (
  vaultDataPath: string,
  path: string,
  offset: number,
  limit: number,
  rev?: string
): Promise<{items: Version[]; last: boolean}> => {
  // No --skip: git skips before --follow switches names, so a page that starts
  // past a rename would lose the trail (D115).
  const r = await git(vaultDataPath, [
    'log',
    '--follow',
    '--name-status',
    '--format=%x1e%H%x1f%aI%x1f%an%x1f%s',
    `--max-count=${offset + limit + 1}`,
    ...(rev ? [rev] : []),
    '--',
    path
  ]);
  if (r.exitCode !== 0) throw new Error(`git log failed: ${gitFailure(r)}`);
  const items = r.stdout
    .split('\x1e')
    .slice(1)
    .map(chunk => {
      const [head = '', ...lines] = chunk.split('\n');
      const [sha = '', date = '', author = '', subject = ''] = head.split('\x1f');
      const status = lines.find(l => l.includes('\t'))?.split('\t') ?? [];
      return {
        sha,
        date,
        author,
        subject,
        path: status.at(-1) ?? path,
        change: CHANGES[status[0]?.[0] ?? 'M'] ?? 'modified'
      };
    });
  return {items: items.slice(offset, offset + limit), last: items.length <= offset + limit};
};

/** The note's bytes at a commit, or null when that commit has no such file. */
export const readVersion = async (
  vaultDataPath: string,
  sha: string,
  path: string
): Promise<string | null> => {
  const r = await git(vaultDataPath, ['show', `${sha}:${path}`]);
  return r.exitCode === 0 ? r.stdout : null;
};

const isUncommitted = async (vaultDataPath: string, path: string): Promise<boolean> => {
  const r = await git(vaultDataPath, ['status', '--porcelain', '--', path]);
  if (r.exitCode !== 0) throw new Error(`git status failed: ${gitFailure(r)}`);
  return r.stdout.trim().length > 0;
};

interface HistoryDeps {
  vaultDataPath: string;
}

/**
 * GET /history?path=&offset=&limit= — a note's committed versions, newest
 * first, one page at a time: `{path, uncommitted, items: [{sha, date,
 * author, subject, path, change}], offset, limit, last}`. No total: counting walks the
 * whole history (D115). `uncommitted` says the file differs from its last
 * commit, so its current version is not listed yet.
 */
export const historyHandler =
  (deps: HistoryDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, new Set(['path', 'offset', 'limit']))) return;
    const path = ctx.query['path'];
    if (path === undefined || !path.endsWith('.md')) {
      sendError(ctx.res, 400, 'bad_request', 'path must name a .md file');
      return;
    }
    try {
      ensureSafePath(deps.vaultDataPath, path);
    } catch (err) {
      if (!(err instanceof WriterError)) throw err;
      sendError(ctx.res, err.status, err.code, err.message);
      return;
    }
    if (!isGitRepo(deps.vaultDataPath)) {
      sendError(ctx.res, 503, 'not_a_git_repo', 'vault data path is not a git repository');
      return;
    }
    const {offset, limit} = parsePagination(ctx.query, {defaultLimit: 50});
    const [page, uncommitted] = await Promise.all([
      listVersions(deps.vaultDataPath, path, offset, limit),
      isUncommitted(deps.vaultDataPath, path)
    ]);
    sendJson(ctx.res, 200, {path, uncommitted, ...page, offset, limit});
  };

interface RestoreDeps {
  db: DatabaseSync;
  vaultDataPath: string;
  records: RecordsRepository;
  resolverCache: ResolverCache;
  tagChecker: TagChecker;
  gitAuthorName: string;
  gitAuthorEmail: string;
}

interface RestoreBody {
  path?: unknown;
  sha?: unknown;
  from_path?: unknown;
  expected_etag?: unknown;
}

const isMdPath = (v: unknown): v is string => typeof v === 'string' && v.endsWith('.md');

/**
 * POST /vault/restore `{path, sha, from_path?, expected_etag?}` — write the
 * note at `path` back to its version at `sha`, read from `from_path` (the
 * version's own path, when a rename came between; default `path`). The bytes
 * go through the writer with the frontmatter replaced whole, then the import
 * and the scoped edge pass, as a PUT runs them. When the file differs from its
 * last commit, it is committed on its own first, so the content the restore
 * replaces stays in the history; nothing is written if that commit fails.
 * Answers `{path, etag, restored_from: {sha, path}, committed_before}`.
 */
export const restoreHandler =
  (deps: RestoreDeps): Handler =>
  async ctx => {
    if (!rejectUnknownParams(ctx, NO_QUERY_PARAMS)) return;
    let body: RestoreBody;
    try {
      body = JSON.parse(await readBodyText(ctx.req)) as RestoreBody;
    } catch {
      sendError(ctx.res, 400, 'invalid_json', 'request body must be a JSON object');
      return;
    }
    const {path, sha, expected_etag: expectedEtag} = body ?? {};
    const fromPath = body?.from_path ?? path;
    if (!isMdPath(path) || !isMdPath(fromPath)) {
      sendError(ctx.res, 400, 'bad_request', 'path and from_path must name .md files');
      return;
    }
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) {
      sendError(ctx.res, 400, 'bad_request', 'sha must be 7 to 40 lowercase hex digits');
      return;
    }
    if (expectedEtag !== undefined && typeof expectedEtag !== 'string') {
      sendError(ctx.res, 400, 'bad_request', 'expected_etag must be a string');
      return;
    }
    let absolute: string;
    try {
      absolute = ensureSafePath(deps.vaultDataPath, path);
      ensureSafePath(deps.vaultDataPath, fromPath);
    } catch (err) {
      if (!(err instanceof WriterError)) throw err;
      sendError(ctx.res, err.status, err.code, err.message);
      return;
    }
    if (!isGitRepo(deps.vaultDataPath)) {
      sendError(ctx.res, 503, 'not_a_git_repo', 'vault data path is not a git repository');
      return;
    }
    const isFile = existsSync(absolute) && statSync(absolute).isFile();
    if (!isFile && existsSync(join(absolute.slice(0, -'.md'.length), '_about.md'))) {
      sendError(
        ctx.res,
        409,
        'shadow_conflict',
        `restoring ${path} would shadow the atomized folder ${path.slice(0, -'.md'.length)}/`
      );
      return;
    }

    const markdown = await readVersion(deps.vaultDataPath, sha, fromPath);
    if (markdown === null) {
      sendError(ctx.res, 404, 'version_not_found', `no ${fromPath} at ${sha}`);
      return;
    }

    let committedBefore: string | null = null;
    if (await isUncommitted(deps.vaultDataPath, path)) {
      const add = await git(deps.vaultDataPath, ['add', '--', path]);
      // The content kept is its last writer's, so the commit is theirs (D136).
      const writer = writersOf(deps.db, [path]).get(path);
      const passStart = new Date().toISOString();
      const commit =
        add.exitCode === 0
          ? await git(deps.vaultDataPath, [
              '-c',
              `user.name=${deps.gitAuthorName}`,
              '-c',
              `user.email=${deps.gitAuthorEmail}`,
              '--literal-pathspecs',
              'commit',
              ...(writer
                ? [`--author=${writer.name} <${writer.email ?? deps.gitAuthorEmail}>`]
                : []),
              '-m',
              `vault-storage: ${path} before restoring ${sha.slice(0, 7)}`,
              ...(writer ? ['-m', `Key: ${writer.name} (${writer.kind}, ${writer.key_id})`] : []),
              '--',
              path
            ])
          : add;
      if (commit.exitCode === 0) clearWriters(deps.db, [path], passStart);
      // The sync loop committed the path between the status and this commit.
      const taken = /nothing to commit|no changes added to commit/i.test(
        commit.stdout + commit.stderr
      );
      if (commit.exitCode !== 0 && !taken) {
        sendError(
          ctx.res,
          503,
          'git_commit_failed',
          `the current ${path} could not be committed before the restore, so nothing was written: ${gitFailure(commit)}`
        );
        return;
      }
      if (commit.exitCode === 0) {
        committedBefore = await getCurrentHead(deps.vaultDataPath);
        if (committedBefore) setLastIndexedCommit(deps.db, committedBefore);
      }
    }

    const {records} = deps;
    const existing = records.getByPath(path);
    let etag: string;
    let unknownTags: UnknownTagRef[];
    try {
      unknownTags = deps.tagChecker.unknownIn(
        requestTags(parseWriteRequest(markdown, 'text/markdown'))
      );
      etag = writeRecordToDisk({
        filePath: path,
        existing,
        requestMarkdown: markdown,
        vaultDataPath: deps.vaultDataPath,
        replaceFrontmatter: true,
        ...(expectedEtag !== undefined ? {ifMatch: expectedEtag} : {})
      }).etag;
    } catch (err) {
      if (!(err instanceof WriterError)) throw err;
      sendError(ctx.res, err.status, err.code, err.message, err.details);
      return;
    }

    const {recordId} = importFile(records, path, absolute, undefined, fullImportOptions(deps.db));
    buildEdges(deps.db, {vaultRoot: deps.vaultDataPath, scope: new Set([recordId])});
    if (!existing) deps.resolverCache.invalidate();
    sendJson(
      ctx.res,
      200,
      {
        path,
        etag,
        restored_from: {sha, path: fromPath},
        committed_before: committedBefore,
        ...(unknownTags.length > 0
          ? {unknown_tags: await deps.tagChecker.withNearest(unknownTags)}
          : {})
      },
      {ETag: `"${etag}"`}
    );
  };

const CURRENT = 'current';
const DIFF_FORMATS = new Set(['unified', 'words']);

/** A version (`sha` set), the note on disk (`sha` null), or null for an empty side. */
interface Side {
  sha: string | null;
  path: string;
  text: string;
}

/** The newest version of `path` before the commit `rev`, or at all without one; renames followed. */
const versionBefore = async (
  vaultDataPath: string,
  path: string,
  rev?: string
): Promise<Version | null> => {
  const [first, second] = (await listVersions(vaultDataPath, path, 0, 2, rev)).items;
  return (rev !== undefined && first?.sha.startsWith(rev) ? second : first) ?? null;
};

const readCurrent = async (absolute: string): Promise<string | null> => {
  try {
    return await readFile(absolute, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return null;
    throw err;
  }
};

const sideLabel = (side: Side | null): string =>
  side === null
    ? '/dev/null'
    : side.sha === null
      ? side.path
      : `${side.sha.slice(0, 8)}:${side.path}`;

/** git's diff of two texts, unified or `--word-diff=porcelain`, headed by the sides' labels; '' when they match. */
const diffTexts = async (from: Side | null, to: Side | null, format: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-diff-'));
  try {
    await Promise.all([
      writeFile(join(dir, 'a'), from?.text ?? ''),
      writeFile(join(dir, 'b'), to?.text ?? '')
    ]);
    const r = await runGit(
      dir,
      [
        'diff',
        '--no-index',
        '--no-color',
        '--no-ext-diff',
        '--text',
        ...(format === 'words' ? ['--word-diff=porcelain'] : []),
        '--',
        'a',
        'b'
      ],
      {timeoutMs: HISTORY_TIMEOUT_MS}
    );
    // --no-index exits 1 when the files differ.
    if (r.exitCode !== 0 && r.exitCode !== 1) throw new Error(`git diff failed: ${gitFailure(r)}`);
    const hunks = r.stdout.search(/^@@/m);
    return hunks < 0
      ? ''
      : `--- ${sideLabel(from)}\n+++ ${sideLabel(to)}\n${r.stdout.slice(hunks)}`;
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
};

/**
 * GET /history/diff?path=&from=&from_path=&to=&to_path=&format= — what changed
 * between two versions of a note, or a version and the note on disk, as git's
 * diff of the markdown, frontmatter included. `to` is a sha, or `current`
 * (default) for the note on disk at `path`; `from` is a sha, `current`, or
 * absent for the version before `to`, found across renames. `from_path` and
 * `to_path` name a version's own path (default `path`). `format` is `unified`
 * (default) or `words`, git's `--word-diff=porcelain`. Answers `{path, from,
 * to, format, diff}`, each side `{sha, path}` with `sha` null for the note on
 * disk, or null when it is empty (no version before `to`, no note on disk);
 * `diff` is '' when the sides match.
 */
export const historyDiffHandler =
  (deps: HistoryDeps): Handler =>
  async ctx => {
    const params = ['path', 'from', 'from_path', 'to', 'to_path', 'format'];
    if (!rejectUnknownParams(ctx, new Set(params))) return;
    const q = ctx.query;
    const path = q['path'];
    const from = q['from'];
    const to = q['to'] ?? CURRENT;
    const fromPath = q['from_path'] ?? path;
    const toPath = q['to_path'] ?? path;
    const format = q['format'] ?? 'unified';
    if (!isMdPath(path) || !isMdPath(fromPath) || !isMdPath(toPath)) {
      sendError(ctx.res, 400, 'bad_request', 'path, from_path, and to_path must name .md files');
      return;
    }
    for (const [name, value] of [
      ['from', from],
      ['to', to]
    ] as const) {
      if (value !== undefined && value !== CURRENT && !SHA_RE.test(value)) {
        sendError(
          ctx.res,
          400,
          'bad_request',
          `${name} must be 7 to 40 lowercase hex digits, or current`
        );
        return;
      }
    }
    if (q['from_path'] !== undefined && (from === undefined || from === CURRENT)) {
      sendError(ctx.res, 400, 'bad_request', 'from_path applies only with a from sha');
      return;
    }
    if (q['to_path'] !== undefined && to === CURRENT) {
      sendError(ctx.res, 400, 'bad_request', 'to_path applies only with a to sha');
      return;
    }
    if (!DIFF_FORMATS.has(format)) {
      sendError(ctx.res, 400, 'bad_request', 'format must be "unified" or "words"');
      return;
    }
    let absolute: string;
    try {
      absolute = ensureSafePath(deps.vaultDataPath, path);
      ensureSafePath(deps.vaultDataPath, fromPath);
      ensureSafePath(deps.vaultDataPath, toPath);
    } catch (err) {
      if (!(err instanceof WriterError)) throw err;
      sendError(ctx.res, err.status, err.code, err.message);
      return;
    }
    if (!isGitRepo(deps.vaultDataPath)) {
      sendError(ctx.res, 503, 'not_a_git_repo', 'vault data path is not a git repository');
      return;
    }

    const current = async (): Promise<Side | null> => {
      const text = await readCurrent(absolute);
      return text === null ? null : {sha: null, path, text};
    };
    // An explicit version must exist; the version found before `to` may be a deletion.
    const version = async (sha: string, at: string): Promise<Side | undefined> => {
      const text = await readVersion(deps.vaultDataPath, sha, at);
      if (text !== null) return {sha, path: at, text};
      sendError(ctx.res, 404, 'version_not_found', `no ${at} at ${sha}`);
      return undefined;
    };

    const toSide = to === CURRENT ? await current() : await version(to, toPath);
    if (toSide === undefined) return;
    let fromSide: Side | null | undefined;
    if (from === CURRENT) fromSide = await current();
    else if (from !== undefined) fromSide = await version(from, fromPath);
    else {
      const before = await versionBefore(
        deps.vaultDataPath,
        toPath,
        to === CURRENT ? undefined : to
      );
      const text =
        before === null ? null : await readVersion(deps.vaultDataPath, before.sha, before.path);
      fromSide =
        before !== null && text !== null ? {sha: before.sha, path: before.path, text} : null;
    }
    if (fromSide === undefined) return;

    const side = (s: Side | null) => (s === null ? null : {sha: s.sha, path: s.path});
    sendJson(ctx.res, 200, {
      path,
      from: side(fromSide),
      to: side(toSide),
      format,
      diff: await diffTexts(fromSide, toSide, format)
    });
  };
