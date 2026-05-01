import test from 'tape-six';
import {computeDecayScore, DEFAULT_DECAY_LAMBDA} from '../src/records/decay.ts';

const day = (n: number): string => {
  const d = new Date('2026-05-01T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
};

const NOW = new Date('2026-05-01T00:00:00Z');

test('computeDecayScore: freshly read record scores 1.0', t => {
  const score = computeDecayScore({lastReferenced: NOW.toISOString(), created: day(100)}, NOW);
  t.equal(score, 1, 'just-read = full score');
});

test('computeDecayScore: never-referenced record decays from created', t => {
  const score = computeDecayScore({lastReferenced: null, created: day(100)}, NOW);
  // exp(-0.005 * 100) ~= 0.6065
  t.ok(score > 0.6 && score < 0.62, `~0.6065 at 100 days; got ${score}`);
});

test('computeDecayScore: recent reference resets the clock', t => {
  // Record created 365 days ago but read 1 day ago — score should reflect 1 day.
  const score = computeDecayScore({lastReferenced: day(1), created: day(365)}, NOW);
  // exp(-0.005 * 1) ~= 0.995
  t.ok(score > 0.99, `~0.995 at 1 day; got ${score}`);
});

test('computeDecayScore: future anchor (clock skew) clamps to 1', t => {
  const future = new Date(NOW.getTime() + 86400000).toISOString();
  const score = computeDecayScore({lastReferenced: future, created: day(10)}, NOW);
  t.equal(score, 1, 'future anchor → 1.0');
});

test('computeDecayScore: 1 year decay', t => {
  const score = computeDecayScore({lastReferenced: day(365), created: day(365)}, NOW);
  // exp(-0.005 * 365) ~= 0.161
  t.ok(score > 0.15 && score < 0.17, `~0.161 at 365 days; got ${score}`);
});

test('computeDecayScore: monotonic — more days = lower score', t => {
  const a = computeDecayScore({lastReferenced: day(30), created: day(30)}, NOW);
  const b = computeDecayScore({lastReferenced: day(60), created: day(60)}, NOW);
  const c = computeDecayScore({lastReferenced: day(90), created: day(90)}, NOW);
  t.ok(a > b, '30d > 60d');
  t.ok(b > c, '60d > 90d');
});

test('computeDecayScore: custom lambda compounds correctly', t => {
  const aggressive = computeDecayScore({lastReferenced: day(30), created: day(30)}, NOW, 0.05);
  const standard = computeDecayScore(
    {lastReferenced: day(30), created: day(30)},
    NOW,
    DEFAULT_DECAY_LAMBDA
  );
  t.ok(aggressive < standard, 'higher lambda decays faster');
  // 0.05 * 30 = 1.5 → exp(-1.5) ~= 0.223
  t.ok(aggressive > 0.21 && aggressive < 0.24, `~0.223 with lambda=0.05; got ${aggressive}`);
});
