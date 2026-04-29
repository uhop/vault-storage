import {readFileSync} from 'node:fs';
import {parseFrontmatter} from '../markdown/frontmatter.ts';
import type {RecordsRepository} from '../records/repository.ts';
import {RECORD_STATUSES, type RecordStatus, type VaultRecord} from '../records/types.ts';
import {contentHash} from '../util/hash.ts';
import {uuidv7} from '../util/uuid.ts';
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

/**
 * Read a single markdown file, derive a record, and upsert into the repository.
 * Returns 'unchanged' when content_hash matches the existing row AND every
 * frontmatter-derived field is already correct — the importer uses this to
 * skip embedding recomputation. A frontmatter-only edit (e.g. `type:` change)
 * still flows through the upsert path so the DB stays consistent with disk.
 */
export const importFile = (
  records: RecordsRepository,
  relativePath: string,
  absolutePath: string,
  now: string = new Date().toISOString()
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

  if (
    existing &&
    existing.contentHash === hash &&
    existing.type === type &&
    existing.status === status &&
    existing.title === title &&
    existing.priority === priority
  ) {
    return {action: 'unchanged', recordId: existing.recordId};
  }

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
  return {action: existing ? 'updated' : 'inserted', recordId: record.recordId};
};
