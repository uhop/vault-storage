import {readFileSync} from 'node:fs';
import {parseFrontmatter} from '../markdown/frontmatter.ts';
import type {RecordsRepository} from '../records/repository.ts';
import {
  PRIORITY_ALIASES,
  RECORD_STATUSES,
  STATUS_ALIASES,
  type RecordStatus,
  type VaultRecord
} from '../records/types.ts';
import {contentHash, embedInputHash} from '../util/hash.ts';
import {uuidv7} from '../util/uuid.ts';
import type {
  AgentEnrichmentStaleFiler,
  ArchiveCandidateFiler,
  TagSuggestionFiler
} from './file-suggestions.ts';
import type {TagsImporter} from './import-tags.ts';
import {isRecordType, typeFromPath} from './type-from-path.ts';

const DEFAULT_STATUS: RecordStatus = 'active';
const STATUS_SET: ReadonlySet<string> = new Set(RECORD_STATUSES);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Normalize FM `status` into a canonical {@link RecordStatus}. Canonical
 * values pass through; known legacy aliases (`completed`, `in-progress`,
 * etc.) map to their canonical equivalents per closed-enums design.
 * Unknown values fall back to the default.
 */
const normalizeStatus = (raw: unknown): RecordStatus => {
  if (typeof raw !== 'string') return DEFAULT_STATUS;
  if (STATUS_SET.has(raw)) return raw as RecordStatus;
  const aliased = STATUS_ALIASES[raw];
  if (aliased !== undefined) return aliased;
  return DEFAULT_STATUS;
};

/**
 * Normalize FM `priority` into the canonical integer. Numbers pass
 * through (any finite int; the field is open-ended). Named aliases
 * (`low`/`normal`/`high`/`critical`) map per closed-enums design.
 * Anything else defaults to 0.
 */
const normalizePriority = (raw: unknown): number => {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const aliased = PRIORITY_ALIASES[raw];
    if (aliased !== undefined) return aliased;
  }
  return 0;
};

interface AgentBlock {
  summary: string | null;
  derivedFromHash: string | null;
  tagsSuggested: string[];
}

/**
 * Extract `agent.summary`, `agent.derived_from_hash`, and `agent.tags_suggested`
 * from frontmatter. Anything malformed (non-object `agent:`, non-string fields,
 * non-array `tags_suggested`) is treated as absent — the chunker / embedder
 * fall back to body-only and no suggestions are filed.
 */
const readAgentBlock = (data: Record<string, unknown>): AgentBlock => {
  const raw = data['agent'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {summary: null, derivedFromHash: null, tagsSuggested: []};
  }
  const block = raw as Record<string, unknown>;
  const summary = asString(block['summary']);
  const derivedFromHash = asString(block['derived_from_hash']);
  const rawTagsSuggested = block['tags_suggested'];
  const tagsSuggested = Array.isArray(rawTagsSuggested)
    ? rawTagsSuggested.filter((t): t is string => typeof t === 'string' && t.length > 0)
    : [];
  return {
    summary: summary && summary.length > 0 ? summary : null,
    derivedFromHash: derivedFromHash && derivedFromHash.length > 0 ? derivedFromHash : null,
    tagsSuggested
  };
};

export interface ImportFileResult {
  /** 'inserted' on first import, 'updated' on subsequent runs. */
  action: 'inserted' | 'updated' | 'unchanged';
  recordId: string;
}

export interface ImportFileOptions {
  /** When provided, syncs the record's tag set from frontmatter `tags:`. */
  tags?: TagsImporter;
  /**
   * When provided, files an `agent_enrichment_stale` suggestion for records
   * whose FM has both `agent.summary` and `agent.derived_from_hash` but the
   * recorded hash diverges from the body's current hash. Auto-resolves
   * pending stale suggestions for records that are no longer stale.
   */
  agentStale?: AgentEnrichmentStaleFiler;
  /**
   * When provided, files `tag_suggestion` entries for tags listed in
   * `agent.tags_suggested` that are not yet realized on the record. Auto-
   * resolves pending suggestions when a previously-suggested tag is now in
   * the record's tag set. Requires `tags` to also be set (the tag-set
   * comparison goes through TagsImporter).
   */
  tagSuggestion?: TagSuggestionFiler;
  /**
   * When provided, auto-resolves any pending `archive_candidate` suggestion
   * for a record whose FM status has flipped to `archived`. The retention
   * scan files the suggestions; this hook closes the loop on the import side
   * once the user (or skill) acts.
   */
  archiveCandidate?: ArchiveCandidateFiler;
}

/**
 * Read a single markdown file, derive a record, and upsert into the repository.
 * Returns 'unchanged' when content_hash matches the existing row AND every
 * frontmatter-derived field is already correct — the importer uses this to
 * skip embedding recomputation. A frontmatter-only edit (e.g. `type:` change)
 * still flows through the upsert path so the DB stays consistent with disk.
 *
 * Tags are synced from frontmatter on every call regardless of unchanged
 * status. A `tags:`-only edit doesn't change content_hash or any tracked
 * record field, so it would otherwise hit the unchanged branch and skip
 * tag updates. Same for records imported before TagsImporter existed —
 * subsequent reindexes detected `unchanged` and never backfilled tags.
 */
export const importFile = (
  records: RecordsRepository,
  relativePath: string,
  absolutePath: string,
  now: string = new Date().toISOString(),
  options: ImportFileOptions = {}
): ImportFileResult => {
  const source = readFileSync(absolutePath, 'utf8');
  const {data, body} = parseFrontmatter(source);

  const existing = records.getByPath(relativePath);

  const fmType = data['type'];
  const type = isRecordType(fmType) ? fmType : typeFromPath(relativePath);

  const status = normalizeStatus(data['status']);

  const created = asString(data['created']) ?? existing?.created ?? now;
  const updated = asString(data['updated']) ?? existing?.updated ?? now;
  const priority = normalizePriority(data['priority']);
  const title = asString(data['title']) ?? null;
  const agent = readAgentBlock(data);

  // Hashes the embedding input (body + agent.summary when present) so
  // summary-only edits drive reembedding the same way body edits do.
  // Falls back to body-only when there's no agent block — the entire
  // current vault until enrich-all runs.
  const hash = embedInputHash(body, agent.summary);

  const isUnchanged =
    !!existing &&
    existing.contentHash === hash &&
    existing.type === type &&
    existing.status === status &&
    existing.title === title &&
    existing.priority === priority &&
    existing.created === created &&
    existing.updated === updated &&
    existing.agentSummary === agent.summary &&
    existing.agentDerivedFromHash === agent.derivedFromHash;

  let recordId: string;
  let action: 'inserted' | 'updated' | 'unchanged';

  if (isUnchanged) {
    recordId = existing.recordId;
    action = 'unchanged';
  } else {
    const record: VaultRecord = {
      recordId: existing?.recordId ?? uuidv7(),
      filePath: relativePath,
      parentPath: existing?.parentPath ?? null,
      sequenceKey: existing?.sequenceKey ?? null,
      type,
      body,
      contentHash: hash,
      title,
      created,
      updated,
      lastReferenced: existing?.lastReferenced ?? null,
      decayScore: existing?.decayScore ?? 1,
      status,
      priority,
      archivedAt: existing?.archivedAt ?? null,
      agentSummary: agent.summary,
      agentDerivedFromHash: agent.derivedFromHash
    };

    records.upsertByPath(record);
    recordId = record.recordId;
    action = existing ? 'updated' : 'inserted';
  }

  if (options.tags) {
    const result = options.tags.syncTags(recordId, relativePath, data['tags']);
    if (result.rejected.length > 0) {
      process.stderr.write(
        `tags ${relativePath}: ${result.rejected.length} unknown (${result.rejected.join(', ')}); ${result.suggestionsFiled} new_tag suggestion(s) filed\n`
      );
    }
  }

  // Agent-judged tag suggestions. Each tag in `agent.tags_suggested` that
  // isn't already on the record's resolved tag set files a pending
  // `tag_suggestion`. Tags that ARE realized auto-accept any prior pending
  // suggestion (the user/agent followed through). Requires both options.tags
  // and options.tagSuggestion — without TagsImporter we can't tell what's
  // realized, so the comparison would be unsafe.
  if (options.tagSuggestion && options.tags && agent.tagsSuggested.length > 0) {
    const realized = options.tags.getTagsForRecord(recordId);
    const seen = new Set<string>();
    for (const raw of agent.tagsSuggested) {
      const tag = options.tags.resolveTag(raw);
      if (tag === null || seen.has(tag)) continue;
      seen.add(tag);
      if (realized.has(tag)) {
        options.tagSuggestion.autoAcceptForRecordTag(recordId, tag, now);
      } else {
        options.tagSuggestion.fileTagSuggestion({
          recordId,
          filePath: relativePath,
          tag,
          now
        });
      }
    }
  }

  // Archive-candidate auto-resolve. When a record's FM status reaches
  // `archived`, any pending archive_candidate for it is moot — accept it
  // as resolved on the import side so the suggestions queue tracks reality.
  if (options.archiveCandidate && status === 'archived') {
    options.archiveCandidate.autoAcceptForRecord(recordId, now);
  }

  // Agent-enrichment staleness check. Only meaningful when both fields are
  // populated — partial blocks (summary without hash, or vice versa) are
  // ambiguous and silently skipped.
  if (options.agentStale && agent.summary !== null && agent.derivedFromHash !== null) {
    const bodyHash = contentHash(body);
    if (agent.derivedFromHash === bodyHash) {
      // Fresh again — auto-accept any pending stale suggestion for this record.
      options.agentStale.autoAcceptForRecord(recordId, now);
    } else {
      options.agentStale.fileStaleSuggestion({
        recordId,
        filePath: relativePath,
        agentDerivedFromHash: agent.derivedFromHash,
        currentBodyHash: bodyHash,
        now
      });
    }
  }

  return {action, recordId};
};
