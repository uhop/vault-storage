import type {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {SuggestionFiler} from '../../importer/file-suggestions.ts';
import {importFile} from '../../importer/import-file.ts';
import {TagsImporter} from '../../importer/import-tags.ts';
import type {RecordsRepository} from '../../records/repository.ts';
import {readBodyText} from '../body.ts';
import {sendError, sendNoContent} from '../responses.ts';
import type {Handler} from '../router.ts';
import {
  parseWriteRequest,
  WriterError,
  writeRecordToDisk,
  writeSplitRecordToDisk
} from '../writer.ts';

// No ResolverCache here: PUT /sections/{id} requires an existing record and
// writes at its current path, so the path set can't change under it.
interface WriteDeps {
  db: DatabaseSync;
  vaultDataPath: string;
  records: RecordsRepository;
}

export const putRecordHandler =
  (deps: WriteDeps): Handler =>
  async ctx => {
    const id = ctx.params['id'];
    if (!id) {
      sendError(ctx.res, 400, 'bad_request', 'missing record_id');
      return;
    }

    const {records} = deps;
    const tags = new TagsImporter(deps.db);
    const agentStale = new SuggestionFiler(deps.db, 'agent_enrichment_stale');
    const tagSuggestion = new SuggestionFiler(deps.db, 'tag_suggestion');
    const archiveCandidate = new SuggestionFiler(deps.db, 'archive_candidate');
    const existing = records.getById(id);
    if (!existing) {
      sendError(ctx.res, 404, 'record_not_found', `no record with id ${id}`);
      return;
    }

    let rawBody: string;
    try {
      rawBody = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }

    const ifMatch = ctx.req.headers['if-match'];
    let etag: string;
    try {
      const parsed = parseWriteRequest(rawBody, ctx.req.headers['content-type']);
      const result =
        parsed.kind === 'json'
          ? writeSplitRecordToDisk({
              filePath: existing.filePath,
              existing,
              frontmatter: parsed.frontmatter,
              body: parsed.body,
              vaultDataPath: deps.vaultDataPath,
              ...(typeof ifMatch === 'string' ? {ifMatch} : {})
            })
          : writeRecordToDisk({
              filePath: existing.filePath,
              existing,
              requestMarkdown: parsed.markdown,
              vaultDataPath: deps.vaultDataPath,
              ...(typeof ifMatch === 'string' ? {ifMatch} : {})
            });
      etag = result.etag;
    } catch (err) {
      if (err instanceof WriterError) {
        sendError(ctx.res, err.status, err.code, err.message, err.details);
        return;
      }
      throw err;
    }

    // Re-import: parses the file we just wrote, recomputes content_hash, and
    // upserts. Preserves record_id (upsert is keyed on file_path).
    const absolutePath = join(deps.vaultDataPath, existing.filePath);
    importFile(records, existing.filePath, absolutePath, undefined, {
      tags,
      agentStale,
      tagSuggestion,
      archiveCandidate
    });

    sendNoContent(ctx.res, {ETag: `"${etag}"`});
  };
