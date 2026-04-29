import type {DatabaseSync} from 'node:sqlite';
import {sendJson} from '../responses.ts';
import type {Handler} from '../router.ts';

export interface SystemDeps {
  db: DatabaseSync;
  schemaVersion: number;
  vaultDataPath: string;
}

export const systemStatusHandler =
  (deps: SystemDeps): Handler =>
  ctx => {
    const {db, schemaVersion, vaultDataPath} = deps;
    const vecVersion = (db.prepare('SELECT vec_version() AS v').get() as {v: string}).v;
    const recordCount = (db.prepare('SELECT COUNT(*) AS n FROM records').get() as {n: number}).n;
    const edgeCount = (db.prepare('SELECT COUNT(*) AS n FROM edges').get() as {n: number}).n;
    const pendingSuggestions = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM suggestions WHERE status = 'pending'`)
        .get() as {n: number}
    ).n;
    const lastIndexedRow = db
      .prepare(`SELECT value FROM meta WHERE key = 'last_indexed_commit'`)
      .get() as {value: string} | undefined;

    sendJson(ctx.res, 200, {
      ok: true,
      schema_version: schemaVersion,
      sqlite_vec_version: vecVersion,
      vault_data_path: vaultDataPath,
      records: recordCount,
      edges: edgeCount,
      pending_suggestions: pendingSuggestions,
      last_indexed_commit: lastIndexedRow ? lastIndexedRow.value : null,
      indexer_running: false
    });
  };
