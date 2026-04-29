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

  return {vaultDataPath, vaultIngestPath, vaultDbPath, apiToken, host, port};
};
