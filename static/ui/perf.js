// Load-path timing, off unless asked for: add `?perf=1` to the URL or set
// `localStorage['vault.perf'] = '1'`. Exists because the slow engine is not
// always the one running the tests — the numbers have to come from the
// browser that is actually slow.

const enabled = (() => {
  try {
    return (
      new URLSearchParams(location.search).get('perf') === '1' ||
      localStorage.getItem('vault.perf') === '1'
    );
  } catch {
    return false;
  }
})();

export const perfOn = enabled;

const t0 = performance.now();
const at = () => ((performance.now() - t0) / 1000).toFixed(2).padStart(7);
const say = (label, ms, detail) =>
  console.log(
    `[perf] ${at()}s  ${ms === null ? '       ' : `${ms.toFixed(0).padStart(6)}ms`}  ${label}${detail ? `  (${detail})` : ''}`
  );

export const mark = (label, detail = '') => {
  if (enabled) say(label, null, detail);
};

/** Run `fn`, and when timing is on report what it cost. */
export const time = (label, fn, detail = '') => {
  if (!enabled) return fn();
  const start = performance.now();
  try {
    return fn();
  } finally {
    say(label, performance.now() - start, detail);
  }
};

export const timeAsync = async (label, fn, detail = '') => {
  if (!enabled) return fn();
  const start = performance.now();
  try {
    return await fn();
  } finally {
    say(label, performance.now() - start, detail);
  }
};

/** Force layout so the engine's own work lands in a line instead of a gap. */
export const layout = (label, el) => {
  if (!enabled) return;
  time(label, () => el.getBoundingClientRect().height);
};

if (enabled) {
  // A stall shows up here even when the work belongs to the engine rather
  // than to any of our own calls, which is the case we cannot instrument.
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    if (now - last > 250) say('MAIN THREAD BLOCKED', now - last, 'engine work, not ours');
    last = now;
  }, 50);
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) say('long task', e.duration, e.name);
    }).observe({entryTypes: ['longtask']});
  } catch {
    mark('longtask observer unavailable in this engine');
  }
  mark('perf logging on');
}
