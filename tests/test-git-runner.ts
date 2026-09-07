import test from 'tape-six';
import {tmpdir} from 'node:os';
import {GIT_TIMEOUT_MS, runGit} from '../src/util/git.ts';

test('runGit kills a child that outlives its timeout and says so', async t => {
  const started = Date.now();
  const result = await runGit(tmpdir(), ['5'], {bin: 'sleep', timeoutMs: 200});
  t.equal(result.timedOut, true, 'timed out');
  t.equal(result.exitCode, -1, 'exit code -1');
  t.ok(result.stderr.includes('timed out after 200 ms'), 'stderr names the timeout');
  t.ok(Date.now() - started < 3000, 'did not wait for the child');
});

test('runGit: a child that finishes in time is untouched, and the default timeout is minutes', async t => {
  const result = await runGit(tmpdir(), ['0'], {bin: 'sleep', timeoutMs: 2000});
  t.equal(result.exitCode, 0);
  t.equal(result.timedOut, undefined, 'no timeout flag on a normal exit');
  t.ok(GIT_TIMEOUT_MS >= 60_000, 'the default is not a test value');
});
