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
  /**
   * Idle window (ms) after the last embed call before the BGE pipeline is
   * disposed. The ONNX inference arena typically occupies several GB once it
   * has been warmed; disposing on idle returns it to the OS. Default 30 min
   * (1_800_000); minimum 1_000. To effectively keep the model resident
   * indefinitely, pass a large value (e.g. 86_400_000 for 24h).
   */
  embedderRetentionMs: number;
  /**
   * Defensive cap on the batch size handed to a single ORT inference. Larger
   * batches activate quadratic attention memory; capping bounds the active-
   * peak RSS. Default 8 (~200-400 MB peak active arena for BGE-small at
   * S=512). Increase for throughput at the cost of memory headroom; decrease
   * if a constrained host can't tolerate even the small peak.
   */
  embedderMaxBatch: number;
  /**
   * JSONL log file path for embedding anomalies (transient NaN chunk vectors
   * from transformers.js+BGE). Default: `${vaultDataPath}/.vault-storage/
   * embed-nan.jsonl`. Set to empty string to disable file logging — stderr
   * notifications still fire.
   */
  embedAnomalyLogPath: string;
  /** When true, periodically `git add -A && git commit` in the vault tree. */
  autoCommit: boolean;
  /** When true and autoCommit is true, also `git push` after each commit. */
  autoPush: boolean;
  /** Polling interval floor for the git-sync loop (back off from here on quiet). */
  commitIntervalMs: number;
  /**
   * Polling interval ceiling for the git-sync loop. After consecutive
   * quiet polls the interval doubles up to this cap (default 2hr); a
   * commit resets to floor. 0 disables backoff (interval stays at floor).
   */
  commitIntervalMaxMs: number;
  /**
   * Work-hours window: when both start and end are set (HH:MM, local time),
   * git-sync polls only inside `[start, end)`. Null values disable the
   * window and the poller runs 24/7. Manual `POST /commit` always wins.
   */
  workHoursStart: string | null;
  workHoursEnd: string | null;
  /** Author/committer identity passed to `git commit` via `-c`. */
  gitAuthorName: string;
  gitAuthorEmail: string;
  /** Directory served at /ui/. Empty string disables the UI surface. */
  uiStaticPath: string;
  /**
   * C8.1 scan scheduler — autonomous cadence for the bundled maintenance
   * scans (`run-all`). Optional so test harnesses that construct ServerEnv
   * literals don't need them; composition applies the defaults. The
   * scheduler shares the git-sync work-hours window (`VAULT_WORK_HOURS_*`)
   * — one definition of "work hours" per deployment.
   */
  scanEnabled?: boolean;
  /** Eligibility-tick cadence (ms). Default 3,600,000 (hourly). */
  scanIntervalMs?: number;
  /**
   * Force a pass when the last one is older than this even with no content
   * changes (time-driven scans need it). Default 604,800,000 (7 days).
   */
  scanMaxQuietMs?: number;
  /**
   * Periodic interval (ms) at which the server logs `memory: rss=… heapUsed=…
   * heapTotal=… external=… arrayBuffers=…` to stdout. Lets you grep
   * `docker logs` for an RSS time-series without external tooling. Set to 0
   * to disable.
   */
  memoryReportIntervalMs: number;
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

  const retentionRaw = process.env['VAULT_EMBEDDER_RETENTION_MS'] ?? '1800000';
  const embedderRetentionMs = Number.parseInt(retentionRaw, 10);
  if (!Number.isFinite(embedderRetentionMs) || embedderRetentionMs < 1000) {
    throw new Error(`VAULT_EMBEDDER_RETENTION_MS must be ≥ 1000 (got ${retentionRaw})`);
  }

  const maxBatchRaw = process.env['VAULT_EMBEDDER_MAX_BATCH'] ?? '8';
  const embedderMaxBatch = Number.parseInt(maxBatchRaw, 10);
  if (!Number.isInteger(embedderMaxBatch) || embedderMaxBatch < 1) {
    throw new Error(`VAULT_EMBEDDER_MAX_BATCH must be a positive integer (got ${maxBatchRaw})`);
  }

  const autoCommit = parseFlag(process.env['VAULT_AUTO_COMMIT'], true);
  const autoPush = parseFlag(process.env['VAULT_AUTO_PUSH'], false);

  const intervalRaw = process.env['VAULT_COMMIT_INTERVAL_MS'] ?? '60000';
  const commitIntervalMs = Number.parseInt(intervalRaw, 10);
  if (!Number.isFinite(commitIntervalMs) || commitIntervalMs < 1000) {
    throw new Error(`VAULT_COMMIT_INTERVAL_MS must be ≥ 1000 (got ${intervalRaw})`);
  }

  const intervalMaxRaw = process.env['VAULT_COMMIT_INTERVAL_MAX_MS'] ?? '7200000';
  const commitIntervalMaxMs = Number.parseInt(intervalMaxRaw, 10);
  if (!Number.isFinite(commitIntervalMaxMs) || commitIntervalMaxMs < 0) {
    throw new Error(`VAULT_COMMIT_INTERVAL_MAX_MS must be ≥ 0 (got ${intervalMaxRaw})`);
  }
  if (commitIntervalMaxMs > 0 && commitIntervalMaxMs < commitIntervalMs) {
    throw new Error(
      `VAULT_COMMIT_INTERVAL_MAX_MS (${commitIntervalMaxMs}) must be ≥ VAULT_COMMIT_INTERVAL_MS (${commitIntervalMs}) when non-zero`
    );
  }

  const workHoursStart = parseTimeOfDay(
    process.env['VAULT_WORK_HOURS_START'],
    'VAULT_WORK_HOURS_START'
  );
  const workHoursEnd = parseTimeOfDay(process.env['VAULT_WORK_HOURS_END'], 'VAULT_WORK_HOURS_END');
  if ((workHoursStart === null) !== (workHoursEnd === null)) {
    throw new Error(
      'VAULT_WORK_HOURS_START and VAULT_WORK_HOURS_END must both be set or both unset'
    );
  }

  const gitAuthorName = process.env['VAULT_GIT_AUTHOR_NAME'] ?? 'vault-storage';
  const gitAuthorEmail = process.env['VAULT_GIT_AUTHOR_EMAIL'] ?? 'vault-storage@localhost';

  const uiStaticPath = process.env['VAULT_UI_STATIC_PATH'] ?? 'static/ui';

  const embedAnomalyLogPath =
    process.env['VAULT_EMBED_ANOMALY_LOG'] ??
    join(vaultDataPath, '.vault-storage', 'embed-nan.jsonl');

  const memoryReportIntervalRaw = process.env['VAULT_MEMORY_REPORT_INTERVAL_MS'] ?? '300000';
  const memoryReportIntervalMs = Number.parseInt(memoryReportIntervalRaw, 10);
  if (!Number.isFinite(memoryReportIntervalMs) || memoryReportIntervalMs < 0) {
    throw new Error(`VAULT_MEMORY_REPORT_INTERVAL_MS must be ≥ 0 (got ${memoryReportIntervalRaw})`);
  }

  const scanEnabled = parseFlag(process.env['VAULT_SCAN_ENABLED'], true);
  const scanIntervalRaw = process.env['VAULT_SCAN_INTERVAL_MS'] ?? '3600000';
  const scanIntervalMs = Number.parseInt(scanIntervalRaw, 10);
  if (!Number.isFinite(scanIntervalMs) || scanIntervalMs < 60_000) {
    throw new Error(`VAULT_SCAN_INTERVAL_MS must be ≥ 60000 (got ${scanIntervalRaw})`);
  }
  const scanMaxQuietRaw = process.env['VAULT_SCAN_MAX_QUIET_MS'] ?? '604800000';
  const scanMaxQuietMs = Number.parseInt(scanMaxQuietRaw, 10);
  if (!Number.isFinite(scanMaxQuietMs) || scanMaxQuietMs < 0) {
    throw new Error(`VAULT_SCAN_MAX_QUIET_MS must be ≥ 0 (got ${scanMaxQuietRaw})`);
  }

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
    embedderRetentionMs,
    embedderMaxBatch,
    autoCommit,
    autoPush,
    commitIntervalMs,
    commitIntervalMaxMs,
    workHoursStart,
    workHoursEnd,
    gitAuthorName,
    gitAuthorEmail,
    uiStaticPath,
    embedAnomalyLogPath,
    memoryReportIntervalMs,
    scanEnabled,
    scanIntervalMs,
    scanMaxQuietMs
  };
};

const parseFlag = (raw: string | undefined, defaultValue: boolean): boolean => {
  if (raw === undefined || raw === '') return defaultValue;
  const v = raw.toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  throw new Error(`expected a boolean flag, got: ${raw}`);
};

const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Parse a `HH:MM` (24-hour, local time) string. Empty/undefined yields null.
 * The string is returned as-is on success — interpretation happens against
 * a `Date` at call time so daylight-saving / TZ rolls are handled by the
 * platform clock rather than baked in.
 */
const parseTimeOfDay = (raw: string | undefined, name: string): string | null => {
  if (raw === undefined || raw === '') return null;
  if (!TIME_OF_DAY_RE.test(raw)) {
    throw new Error(`${name} must match HH:MM (24-hour local time), got '${raw}'`);
  }
  return raw;
};
