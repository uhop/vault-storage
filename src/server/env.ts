import {join} from 'node:path';

export interface ServerEnv {
  /** Markdown content tree — source of truth, what the server reads/writes. */
  vaultDataPath: string;
  /** Optional default source path for the `import` CLI subcommand. */
  vaultIngestPath: string | null;
  /** Path to vault.sqlite. Defaults to `${vaultDataPath}/.vault-storage/vault.sqlite`. */
  vaultDbPath: string;
  /** Bearer token required on every request. */
  apiToken: string;
  host: string;
  port: number;
  /** When true, server runs an importVault pass on startup before listening. */
  autoReindex: boolean;
  /** When true, server starts a file-watcher → debounced incremental reindex. */
  autoWatch: boolean;
  /** Watcher debounce window — events within this gap collapse into one flush. */
  watchDebounceMs: number;
  /** When 'fake', skips the BGE model load. Useful for smoke tests. */
  embedder: 'bge' | 'fake';
  /** When true, periodically `git add -A && git commit` in the vault tree. */
  autoCommit: boolean;
  /** When true and autoCommit is true, also `git push` after each commit. */
  autoPush: boolean;
  /** Polling interval for the git-sync loop. */
  commitIntervalMs: number;
  /** Author/committer identity passed to `git commit` via `-c`. */
  gitAuthorName: string;
  gitAuthorEmail: string;
}

const required = (name: string): string => {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`${name} is required (set it in the environment or .env file)`);
  }
  return value;
};

export const readServerEnv = (): ServerEnv => {
  const vaultDataPath = required('VAULT_DATA_PATH');
  const apiToken = required('VAULT_API_TOKEN');

  const vaultDbPath =
    process.env['VAULT_DB_PATH'] ?? join(vaultDataPath, '.vault-storage', 'vault.sqlite');
  const vaultIngestPath = process.env['VAULT_INGEST_PATH'] ?? null;

  const host = process.env['VAULT_HOST'] ?? '127.0.0.1';
  const portRaw = process.env['VAULT_PORT'] ?? '8123';
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`VAULT_PORT is not a valid port: ${portRaw}`);
  }

  const autoReindex = parseFlag(process.env['VAULT_AUTO_REINDEX'], true);
  const autoWatch = parseFlag(process.env['VAULT_AUTO_WATCH'], true);

  const debounceRaw = process.env['VAULT_WATCH_DEBOUNCE_MS'] ?? '1500';
  const watchDebounceMs = Number.parseInt(debounceRaw, 10);
  if (!Number.isFinite(watchDebounceMs) || watchDebounceMs < 0) {
    throw new Error(`VAULT_WATCH_DEBOUNCE_MS is not a valid integer: ${debounceRaw}`);
  }

  const embedderRaw = (process.env['VAULT_EMBEDDER'] ?? 'bge').toLowerCase();
  if (embedderRaw !== 'bge' && embedderRaw !== 'fake') {
    throw new Error(`VAULT_EMBEDDER must be 'bge' or 'fake' (got '${embedderRaw}')`);
  }
  const embedder = embedderRaw;

  const autoCommit = parseFlag(process.env['VAULT_AUTO_COMMIT'], true);
  const autoPush = parseFlag(process.env['VAULT_AUTO_PUSH'], false);

  const intervalRaw = process.env['VAULT_COMMIT_INTERVAL_MS'] ?? '60000';
  const commitIntervalMs = Number.parseInt(intervalRaw, 10);
  if (!Number.isFinite(commitIntervalMs) || commitIntervalMs < 1000) {
    throw new Error(`VAULT_COMMIT_INTERVAL_MS must be ≥ 1000 (got ${intervalRaw})`);
  }

  const gitAuthorName = process.env['VAULT_GIT_AUTHOR_NAME'] ?? 'vault-storage';
  const gitAuthorEmail = process.env['VAULT_GIT_AUTHOR_EMAIL'] ?? 'vault-storage@localhost';

  return {
    vaultDataPath,
    vaultIngestPath,
    vaultDbPath,
    apiToken,
    host,
    port,
    autoReindex,
    autoWatch,
    watchDebounceMs,
    embedder,
    autoCommit,
    autoPush,
    commitIntervalMs,
    gitAuthorName,
    gitAuthorEmail
  };
};

const parseFlag = (raw: string | undefined, defaultValue: boolean): boolean => {
  if (raw === undefined || raw === '') return defaultValue;
  const v = raw.toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  throw new Error(`expected a boolean flag, got: ${raw}`);
};
