import type {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {importFile} from '../../importer/import-file.ts';
import {TagsImporter} from '../../importer/import-tags.ts';
import {RecordsRepository} from '../../records/repository.ts';
import {readBodyText} from '../body.ts';
import {sendError, sendNoContent} from '../responses.ts';
import type {Handler} from '../router.ts';
import {WriterError, writeRecordToDisk} from '../writer.ts';

interface WriteDeps {
  db: DatabaseSync;
  vaultDataPath: string;
}

export const putRecordHandler =
  (deps: WriteDeps): Handler =>
  async ctx => {
    const id = ctx.params['id'];
    if (!id) {
      sendError(ctx.res, 400, 'bad_request', 'missing record_id');
      return;
    }

    const records = new RecordsRepository(deps.db);
    const tags = new TagsImporter(deps.db);
    const existing = records.getById(id);
    if (!existing) {
      sendError(ctx.res, 404, 'record_not_found', `no record with id ${id}`);
      return;
    }

    let requestMarkdown: string;
    try {
      requestMarkdown = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }

    try {
      writeRecordToDisk({
        filePath: existing.filePath,
        existing,
        requestMarkdown,
        vaultDataPath: deps.vaultDataPath
      });
    } catch (err) {
      if (err instanceof WriterError) {
        sendError(ctx.res, err.status, err.code, err.message);
        return;
      }
      throw err;
    }

    // Re-import: parses the file we just wrote, recomputes content_hash, and
    // upserts. Preserves record_id (upsert is keyed on file_path).
    const absolutePath = join(deps.vaultDataPath, existing.filePath);
    importFile(records, existing.filePath, absolutePath, undefined, {tags});

    sendNoContent(ctx.res);
  };
