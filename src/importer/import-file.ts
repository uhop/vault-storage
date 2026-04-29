import {readFileSync} from 'node:fs';
import {parseFrontmatter} from '../markdown/frontmatter.ts';
import type {RecordsRepository} from '../records/repository.ts';
import {RECORD_STATUSES, type RecordStatus, type VaultRecord} from '../records/types.ts';
import {contentHash} from '../util/hash.ts';
import {uuidv7} from '../util/uuid.ts';
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

export interface ImportFileResult {
  /** 'inserted' on first import, 'updated' on subsequent runs. */
  action: 'inserted' | 'updated' | 'unchanged';
  recordId: string;
}

export interface ImportFileOptions {
  /** When provided, syncs the record's tag set from frontmatter `tags:`. */
  tags?: TagsImporter;
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

  const hash = contentHash(body);
  const existing = records.getByPath(relativePath);

  const fmType = data['type'];
  const type = isRecordType(fmType) ? fmType : typeFromPath(relativePath);

  const fmStatus = data['status'];
  const status = isRecordStatus(fmStatus) ? fmStatus : DEFAULT_STATUS;

  const created = asString(data['created']) ?? existing?.created ?? now;
  const updated = asString(data['updated']) ?? now;
  const priority = asNumber(data['priority']) ?? 0;
  const title = asString(data['title']) ?? null;

  const isUnchanged =
    !!existing &&
    existing.contentHash === hash &&
    existing.type === type &&
    existing.status === status &&
    existing.title === title &&
    existing.priority === priority;

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
      archivedAt: existing?.archivedAt ?? null
    };

    records.upsertByPath(record);
    recordId = record.recordId;
    action = existing ? 'updated' : 'inserted';
  }

  if (options.tags) {
    const result = options.tags.syncTags(recordId, data['tags']);
    if (result.rejected.length > 0) {
      process.stderr.write(
        `tags ${relativePath}: ${result.rejected.length} unknown (${result.rejected.join(', ')})\n`
      );
    }
  }

  return {action, recordId};
};
