// The vault's marker (D119): a tracked `.vault-storage.json` at the root of the
// vault data, so a repository says it is a vault, in which layout format, and
// which one.

import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {uuidv7} from './util/uuid.ts';

export const MARKER_FILE = '.vault-storage.json';
export const MARKER_APP = 'vault-storage';
/** The newest layout format this server reads and writes. */
export const MARKER_FORMAT = 1;

export interface VaultMarker {
  app: typeof MARKER_APP;
  format: number;
  vault_id: string;
  created: string;
}

const isMarker = (v: unknown): v is VaultMarker => {
  if (v === null || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  return (
    m['app'] === MARKER_APP &&
    Number.isInteger(m['format']) &&
    (m['format'] as number) >= 1 &&
    typeof m['vault_id'] === 'string' &&
    m['vault_id'].length > 0 &&
    typeof m['created'] === 'string'
  );
};

/**
 * The marker at the root of `vaultDataPath`, written when absent. Throws on
 * one it cannot trust rather than replacing it, since a new marker is a new
 * vault id: a `SyntaxError` for a file that is not a marker, a `RangeError`
 * for a format newer than this server's.
 */
export const ensureVaultMarker = (
  vaultDataPath: string,
  now: Date = new Date()
): {marker: VaultMarker; created: boolean} => {
  const path = join(vaultDataPath, MARKER_FILE);
  if (!existsSync(path)) {
    const marker: VaultMarker = {
      app: MARKER_APP,
      format: MARKER_FORMAT,
      vault_id: uuidv7(),
      created: now.toISOString()
    };
    writeFileSync(path, `${JSON.stringify(marker, null, 2)}\n`, {flag: 'wx'});
    return {marker, created: true};
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new SyntaxError(`${path} is not JSON; fix it, or delete it to mint a new vault id`, {
      cause: err
    });
  }
  if (!isMarker(data)) {
    throw new SyntaxError(
      `${path} is not a ${MARKER_APP} marker ({app, format, vault_id, created}); fix it, or delete it to mint a new vault id`
    );
  }
  if (data.format > MARKER_FORMAT) {
    throw new RangeError(
      `${path} has format ${data.format}, and this server knows formats up to ${MARKER_FORMAT}: run a newer server`
    );
  }
  return {marker: data, created: false};
};
