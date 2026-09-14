// Periodic RSS/heap log line for leak diagnosis. Single setInterval; the
// timer is `unref`'d so it never keeps the event loop alive on its own.
// Disable by setting VAULT_MEMORY_REPORT_INTERVAL_MS=0.

import {readFile} from 'node:fs/promises';

export interface MemoryReporterOptions {
  intervalMs: number;
  log?: (msg: string) => void;
  /** Resident memory of the embedder's child process, which holds the model (D44); null while none runs. */
  embedderRss?: () => Promise<number | null>;
}

export interface MemoryReporterHandle {
  close(): void;
}

const fmtMb = (bytes: number): string => `${Math.round(bytes / 1024 / 1024)}M`;

/** Resident set size of another process from `/proc/<pid>/status`; null where procfs is unavailable. */
export const processRss = async (pid: number): Promise<number | null> => {
  try {
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(await readFile(`/proc/${pid}/status`, 'utf8'));
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
};

const tick = async (log: (msg: string) => void, opts: MemoryReporterOptions): Promise<void> => {
  const m = process.memoryUsage();
  const child = opts.embedderRss ? await opts.embedderRss() : null;
  log(
    `memory: rss=${fmtMb(m.rss)} heapUsed=${fmtMb(m.heapUsed)} ` +
      `heapTotal=${fmtMb(m.heapTotal)} external=${fmtMb(m.external)} ` +
      `arrayBuffers=${fmtMb(m.arrayBuffers)}` +
      (child === null ? '' : ` embedder_rss=${fmtMb(child)}`)
  );
};

export const startMemoryReporter = (opts: MemoryReporterOptions): MemoryReporterHandle => {
  const log = opts.log ?? (msg => process.stdout.write(`vault-storage: ${msg}\n`));
  void tick(log, opts);
  const timer = setInterval(() => void tick(log, opts), opts.intervalMs);
  timer.unref();
  return {
    close() {
      clearInterval(timer);
    }
  };
};
