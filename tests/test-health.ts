import test from 'tape-six';
import {startHealthMonitor} from '../src/server/health.ts';

const clock = (startMs: number) => {
  let t = startMs;
  return {now: () => new Date(t), advance: (ms: number) => (t += ms)};
};

test('health monitor: outcomes, watchdog lag, and the stalled verdict', async t => {
  const c = clock(Date.parse('2026-09-07T00:00:00Z'));
  const m = startHealthMonitor({watchdogIntervalMs: 1000, now: c.now});
  try {
    let s = m.snapshot();
    t.equal(s.ok, true);
    t.equal(s.uptime_s, 0);
    t.equal(s.git_sync.runs, 0);
    t.equal(s.watcher.last_event_at, null);

    c.advance(1000);
    m.tick();
    t.equal(m.snapshot().loop.lag_ms, 0, 'an on-time tick has no lag');

    c.advance(4500);
    m.tick();
    s = m.snapshot();
    t.equal(s.loop.lag_ms, 3500, 'a late tick measures its lag');
    t.equal(s.loop.max_lag_ms, 3500);
    t.equal(s.stalled, true, 'late by more than twice the interval → stalled');

    c.advance(1000);
    m.tick();
    s = m.snapshot();
    t.equal(s.stalled, false, 'recovered');
    t.equal(s.loop.max_lag_ms, 3500, 'the worst lag is kept');
    t.equal(s.loop.max_lag_at, '2026-09-07T00:00:05.500Z');

    m.recordGitSync({ok: false, error: 'timed out after 300000 ms', timedOut: true});
    s = m.snapshot();
    t.equal(s.git_sync.consecutive_timeouts, 1);
    t.equal(s.git_sync.failures, 1);
    t.equal(s.stalled, true, 'a git child past its timeout → stalled');
    m.recordGitSync({ok: true});
    s = m.snapshot();
    t.equal(s.git_sync.consecutive_timeouts, 0, 'a success clears the streak');
    t.equal(s.git_sync.timeouts, 1, 'the total is kept');
    t.equal(s.stalled, false);

    m.recordReindex({ok: false, error: 'boom'});
    m.recordReindex({ok: true});
    m.recordWatcherEvent();
    s = m.snapshot();
    t.equal(s.reindex.runs, 2);
    t.equal(s.reindex.failures, 1);
    t.equal(s.reindex.last_ok, true);
    t.equal(s.reindex.last_error, null);
    t.equal(s.watcher.events, 1);
    t.equal(s.watcher.last_event_at, c.now().toISOString());
    t.equal(s.uptime_s, 7);
  } finally {
    m.close();
  }
});
