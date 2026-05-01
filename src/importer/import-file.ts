import {readFileSync} from 'node:fs';
import {parseFrontmatter} from '../markdown/frontmatter.ts';
import type {RecordsRepository} from '../records/repository.ts';
import {RECORD_STATUSES, type RecordStatus, type VaultRecord} from '../records/types.ts';
import {contentHash, embedInputHash} from '../util/hash.ts';
import {uuidv7} from '../util/uuid.ts';
import type {AgentEnrichmentStaleFiler} from './file-suggestions.ts';
import type {TagsImporter} from './import-tags.ts';
import {isRecordType, typeFromPath} from './type-from-path.ts';

const DEFAULT_STATUS: RecordStatus = 'active';
const STATUS_SET: ReadonlySet<string> = new Set(RECORD_STATUSES);

const isRecordStatus = (value: unknown): value is RecordStatus =>
  typeof value === 'string' && STATUS_SET.has(value);

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

interface AgentBlock {
  summary: string | null;
  derivedFromHash: string | null;
}

/**
 * Extract `agent.summary` and `agent.derived_from_hash` from frontmatter.
 * Anything malformed (non-object `agent:`, non-string fields) is treated as
 * absent — the chunker / embedder fall back to body-only.
 */
const readAgentBlock = (data: Record<string, unknown>): AgentBlock => {
  const raw = data['agent'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {summary: null, derivedFromHash: null};
  }
  const block = raw as Record<string, unknown>;
  const summary = asString(block['summary']);
  const derivedFromHash = asString(block['derived_from_hash']);
  return {
    summary: summary && summary.length > 0 ? summary : null,
    derivedFromHash: derivedFromHash && derivedFromHash.length > 0 ? derivedFromHash : null
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

  const fmStatus = data['status'];
  const status = isRecordStatus(fmStatus) ? fmStatus : DEFAULT_STATUS;

  const created = asString(data['created']) ?? existing?.created ?? now;
  const updated = asString(data['updated']) ?? existing?.updated ?? now;
  const priority = asNumber(data['priority']) ?? 0;
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
