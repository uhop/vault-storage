// Periodic RSS/heap log line for leak diagnosis. Single setInterval; the
// timer is `unref`'d so it never keeps the event loop alive on its own.
// Disable by setting VAULT_MEMORY_REPORT_INTERVAL_MS=0.

export interface MemoryReporterOptions {
  intervalMs: number;
  log?: (msg: string) => void;
}

export interface MemoryReporterHandle {
  close(): void;
}

const fmtMb = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)}M`;

const tick = (log: (msg: string) => void): void => {
  const m = process.memoryUsage();
  log(
    `memory: rss=${fmtMb(m.rss)} heapUsed=${fmtMb(m.heapUsed)} ` +
      `heapTotal=${fmtMb(m.heapTotal)} external=${fmtMb(m.external)} ` +
      `arrayBuffers=${fmtMb(m.arrayBuffers)}`
  );
};

export const startMemoryReporter = (opts: MemoryReporterOptions): MemoryReporterHandle => {
  const log = opts.log ?? (msg => process.stdout.write(`vault-storage: ${msg}\n`));
  tick(log);
  const timer = setInterval(() => tick(log), opts.intervalMs);
  timer.unref();
  return {
    close() {
      clearInterval(timer);
    }
  };
};
