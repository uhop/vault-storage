import test from 'tape-six';
import {existsSync} from 'node:fs';
import {processRss, startMemoryReporter} from '../src/server/memory-reporter.ts';

test('processRss reads a process resident set from procfs, and null where it cannot', async t => {
  if (existsSync('/proc/self/status')) {
    const rss = await processRss(process.pid);
    t.ok(rss !== null && rss > 1024 * 1024, `this process has an RSS (${rss} bytes)`);
  }
  t.equal(await processRss(-1), null, 'no such process');
});

test('the memory line carries the embedder child RSS only while one runs', async t => {
  const lines: string[] = [];
  let rss: number | null = null;
  const reporter = startMemoryReporter({
    intervalMs: 20,
    log: line => lines.push(line),
    embedderRss: async () => rss
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    t.ok(!lines.some(line => line.includes('embedder_rss')), 'no child, no field');
    rss = 812 * 1024 * 1024;
    await new Promise(resolve => setTimeout(resolve, 60));
    t.ok(
      lines.some(line => line.endsWith(' embedder_rss=812M')),
      'the child RSS is appended once it exists'
    );
  } finally {
    reporter.close();
  }
});
