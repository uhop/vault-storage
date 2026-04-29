import {existsSync} from 'node:fs';
import type {DatabaseSync} from 'node:sqlite';
import {syncFromObsidian} from '../../migration/sync.ts';
import {readBodyText} from '../body.ts';
import {sendError, sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

interface SyncDeps {
  db: DatabaseSync;
  vaultDataPath: string;
}

interface SyncRequest {
  source_path?: string;
  dry_run?: boolean;
  write_log?: boolean;
}

const parseRequest = (raw: string): SyncRequest | string => {
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return 'request body must be a JSON object';
    }
    return parsed as SyncRequest;
  } catch (err) {
    return `invalid JSON: ${(err as Error).message}`;
  }
};

/** POST /sync/from-obsidian — incremental Obsidian → vault-data sync. */
export const syncFromObsidianHandler =
  (deps: SyncDeps): Handler =>
  async ctx => {
    let raw: string;
    try {
      raw = await readBodyText(ctx.req);
    } catch (err) {
      sendError(ctx.res, 413, 'request_too_large', (err as Error).message);
      return;
    }

    const parsed = parseRequest(raw);
    if (typeof parsed === 'string') {
      sendError(ctx.res, 400, 'bad_request', parsed);
      return;
    }

    const sourcePath = parsed.source_path ?? process.env['OBSIDIAN_VAULT_PATH'];
    if (!sourcePath) {
      sendError(
        ctx.res,
        400,
        'bad_request',
        'source_path is required (or set OBSIDIAN_VAULT_PATH on the server)'
      );
      return;
    }
    if (!existsSync(sourcePath)) {
      sendError(ctx.res, 400, 'invalid_path', `source path does not exist: ${sourcePath}`);
      return;
    }

    try {
      const summary = syncFromObsidian({
        source: sourcePath,
        target: deps.vaultDataPath,
        db: deps.db,
        dryRun: parsed.dry_run === true,
        writeLog: parsed.write_log !== false
      });
      sendJson(ctx.res, 200, {
        total: summary.total,
        new: summary.new,
        updated: summary.updated,
        unchanged: summary.unchanged,
        skipped_locally_newer: summary.skippedLocallyNewer,
        skipped_atomized: summary.skippedAtomized,
        removed_in_source: summary.removedInSource,
        duration_ms: summary.durationMs,
        log_path: summary.logPath ?? null,
        files: summary.files.map(f => ({
          file_path: f.relativePath,
          action: f.action,
          note: f.note ?? null
        }))
      });
    } catch (err) {
      sendError(ctx.res, 500, 'internal', (err as Error).message);
    }
  };
