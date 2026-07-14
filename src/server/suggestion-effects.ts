import type {DatabaseSync} from 'node:sqlite';
import {existsSync, readFileSync, statSync} from 'node:fs';
import {buildEdges} from '../importer/build-edges.ts';
import {SuggestionFiler} from '../importer/file-suggestions.ts';
import {importFile} from '../importer/import-file.ts';
import {TagsImporter} from '../importer/import-tags.ts';
import {parseFrontmatter} from '../markdown/frontmatter.ts';
import type {RecordsRepository} from '../records/repository.ts';
import {ensureSafePath, writeSplitRecordToDisk} from './writer.ts';

/**
 * Server-side FM mutations for `POST /suggestions/resolve-batch` — the
 * mechanical halves of a triage decision. The agent judges; these apply.
 * Resolution then settles on contact through the re-import / edge pass
 * (tag realized → `tag-realized`; FM `edges:` override → `fm-override`),
 * mirroring what the review skills did client-side call by call.
 */
export interface EffectDeps {
  db: DatabaseSync;
  vaultDataPath: string;
  records: RecordsRepository;
}

export class EffectError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'EffectError';
    this.code = code;
  }
}

// Tag shape rule from src/server/handlers/tags.ts — keep in sync.
const TAG_RE = /^[a-z0-9][a-z0-9-]*$/;

interface LocatedRecord {
  recordId: string;
  filePath: string;
  abs: string;
  fm: Record<string, unknown>;
  body: string;
}

const locate = (deps: EffectDeps, recordId: string): LocatedRecord => {
  const row = deps.db
    .prepare('SELECT record_id, file_path FROM records WHERE record_id = ?')
    .get(recordId) as {record_id: string; file_path: string} | undefined;
  if (!row) throw new EffectError(`no record with id ${recordId}`, 'record_not_found');
  const abs = ensureSafePath(deps.vaultDataPath, row.file_path);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new EffectError(`no file at ${row.file_path}`, 'file_not_found');
  }
  const {data, body} = parseFrontmatter(readFileSync(abs, 'utf8'));
  return {recordId: row.record_id, filePath: row.file_path, abs, fm: data, body};
};

// The write-side re-import: full filer set so suggestion resolution settles
// on contact rather than at the next reindex.
const reimport = (deps: EffectDeps, rec: LocatedRecord): void => {
  importFile(deps.records, rec.filePath, rec.abs, undefined, {
    tags: new TagsImporter(deps.db),
    agentStale: new SuggestionFiler(deps.db, 'agent_enrichment_stale'),
    tagSuggestion: new SuggestionFiler(deps.db, 'tag_suggestion'),
    archiveCandidate: new SuggestionFiler(deps.db, 'archive_candidate')
  });
};

const writeFm = (deps: EffectDeps, rec: LocatedRecord, fmPatch: Record<string, unknown>): void => {
  writeSplitRecordToDisk({
    filePath: rec.filePath,
    existing: deps.records.getById(rec.recordId),
    frontmatter: fmPatch,
    body: rec.body,
    vaultDataPath: deps.vaultDataPath
  });
  reimport(deps, rec);
};

/**
 * `tag_suggestion` accept: realize the tag on the record's FM `tags:` array.
 * Set-semantics — an already-present tag still re-imports (no disk write), so
 * the pending suggestion settles as `tag-realized` (the 2026-06-20 "no-op
 * accept" residue rule).
 */
export const addTagToRecord = (
  deps: EffectDeps,
  recordId: string,
  tag: string
): {tag_added: boolean} => {
  if (!TAG_RE.test(tag)) {
    throw new EffectError(
      'tag must match [a-z0-9][a-z0-9-]* (lowercase alphanumeric + hyphens)',
      'invalid_tag'
    );
  }
  const rec = locate(deps, recordId);
  const raw = rec.fm['tags'];
  const tags = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
  if (tags.includes(tag)) {
    reimport(deps, rec);
    return {tag_added: false};
  }
  writeFm(deps, rec, {tags: [...tags, tag]});
  return {tag_added: true};
};

/**
 * `tag_suggestion` reject: strip the candidate from `agent.tags_suggested`
 * so the stale proposal doesn't linger in the enrichment block. Best-effort —
 * a missing record/file/block is a no-op (the rejection stands regardless;
 * re-filing is blocked by the filer's all-statuses identity).
 */
export const stripSuggestedTag = (
  deps: EffectDeps,
  recordId: string,
  tag: string
): {candidate_stripped: boolean} => {
  let rec: LocatedRecord;
  try {
    rec = locate(deps, recordId);
  } catch (err) {
    if (err instanceof EffectError) return {candidate_stripped: false};
    throw err;
  }
  const agent = rec.fm['agent'];
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
    return {candidate_stripped: false};
  }
  const block = agent as Record<string, unknown>;
  const suggested = block['tags_suggested'];
  if (!Array.isArray(suggested) || !suggested.includes(tag)) {
    return {candidate_stripped: false};
  }
  writeFm(deps, rec, {agent: {...block, tags_suggested: suggested.filter(t => t !== tag)}});
  return {candidate_stripped: true};
};

/**
 * `edge_type` accept: pin the classified type in the source record's FM
 * `edges:` map, then run a scoped edge pass so the pending suggestion settles
 * as `fm-override` on the write itself. The override key is the target's
 * path sans `.md` — build-edges resolves FM edge keys through the wikilink
 * resolver, so the path form matches regardless of the body's slug form.
 */
export const applyEdgeOverride = (
  deps: EffectDeps,
  fromRecordId: string,
  toPath: string,
  edgeType: string
): {override_key: string} => {
  const rec = locate(deps, fromRecordId);
  const key = toPath.replace(/\.md$/, '');
  const raw = rec.fm['edges'];
  const edges: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? {...(raw as object)} : {};
  if (edges[key] === edgeType) {
    reimport(deps, rec);
  } else {
    edges[key] = edgeType;
    writeFm(deps, rec, {edges});
  }
  buildEdges(deps.db, {vaultRoot: deps.vaultDataPath, scope: new Set([fromRecordId])});
  return {override_key: key};
};
