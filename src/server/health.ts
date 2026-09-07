// In-memory health: what the process knows about itself without touching
// the database or the data mount. `/system/status` reads both, which is why
// it fails when storage fails (the right signal for the container check);
// this answers "is the loop alive, and what did the last passes say" even
// while storage is wedged, so an operator can tell the two apart (2026-09-07:
// a ZFS wedge froze the main thread and every request; nothing in memory
// could have said more than "no answer" — but a hung git child, or a stalled
// watcher drain with a live loop, is the case this covers).

export interface OutcomeRecord {
  last_at: string | null;
  last_ok: boolean | null;
  last_error: string | null;
  runs: number;
  failures: number;
}

export interface HealthSnapshot {
  ok: boolean;
  stalled: boolean;
  at: string;
  started_at: string;
  uptime_s: number;
  loop: {
    watchdog_interval_ms: number;
    last_tick_at: string | null;
    lag_ms: number;
    max_lag_ms: number;
    max_lag_at: string | null;
  };
  git_sync: OutcomeRecord & {consecutive_timeouts: number; timeouts: number};
  reindex: OutcomeRecord;
  watcher: {last_event_at: string | null; events: number};
}

export interface HealthMonitor {
  recordGitSync(outcome: {ok: boolean; error?: string; timedOut?: boolean}): void;
  recordReindex(outcome: {ok: boolean; error?: string}): void;
  recordWatcherEvent(): void;
  snapshot(): HealthSnapshot;
  /** Runs the watchdog tick by hand — tests, and callers that want lag measured now. */
  tick(): void;
  close(): void;
}

export interface HealthMonitorOptions {
  /** Watchdog cadence; a tick that arrives late by more than twice this marks the loop stalled. */
  watchdogIntervalMs?: number;
  now?: () => Date;
}

const DEFAULT_WATCHDOG_MS = 5_000;

const emptyOutcome = (): OutcomeRecord => ({
  last_at: null,
  last_ok: null,
  last_error: null,
  runs: 0,
  failures: 0
});

export const startHealthMonitor = (opts: HealthMonitorOptions = {}): HealthMonitor => {
  const now = opts.now ?? (() => new Date());
  const interval = opts.watchdogIntervalMs ?? DEFAULT_WATCHDOG_MS;
  const startedAt = now();
  let lastTick = startedAt;
  let lagMs = 0;
  let maxLagMs = 0;
  let maxLagAt: string | null = null;
  const gitSync = {...emptyOutcome(), consecutive_timeouts: 0, timeouts: 0};
  const reindex = emptyOutcome();
  let lastEventAt: string | null = null;
  let events = 0;

  const record = (rec: OutcomeRecord, ok: boolean, error?: string): void => {
    rec.last_at = now().toISOString();
    rec.last_ok = ok;
    rec.last_error = ok ? null : (error ?? 'unknown');
    ++rec.runs;
    if (!ok) ++rec.failures;
  };

  const tick = (): void => {
    const t = now();
    lagMs = Math.max(0, t.getTime() - lastTick.getTime() - interval);
    if (lagMs > maxLagMs) {
      maxLagMs = lagMs;
      maxLagAt = t.toISOString();
    }
    lastTick = t;
  };
  const timer = setInterval(tick, interval);
  timer.unref();

  return {
    recordGitSync({ok, error, timedOut}) {
      record(gitSync, ok, error);
      if (timedOut) {
        ++gitSync.timeouts;
        ++gitSync.consecutive_timeouts;
      } else if (ok) {
        gitSync.consecutive_timeouts = 0;
      }
    },
    recordReindex({ok, error}) {
      record(reindex, ok, error);
    },
    recordWatcherEvent() {
      lastEventAt = now().toISOString();
      ++events;
    },
    tick,
    snapshot() {
      const t = now();
      // A stall is a tick that came late, or a git child the loop is waiting
      // on past its timeout: the loop is alive enough to answer, storage
      // underneath is not keeping up.
      const stalled = lagMs > 2 * interval || gitSync.consecutive_timeouts > 0;
      return {
        ok: !stalled,
        stalled,
        at: t.toISOString(),
        started_at: startedAt.toISOString(),
        uptime_s: Math.round((t.getTime() - startedAt.getTime()) / 1000),
        loop: {
          watchdog_interval_ms: interval,
          last_tick_at: lastTick.toISOString(),
          lag_ms: lagMs,
          max_lag_ms: maxLagMs,
          max_lag_at: maxLagAt
        },
        git_sync: {...gitSync},
        reindex: {...reindex},
        watcher: {last_event_at: lastEventAt, events}
      };
    },
    close() {
      clearInterval(timer);
    }
  };
};
