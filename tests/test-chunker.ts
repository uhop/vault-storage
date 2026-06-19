import test from 'tape-six';
import {chunkBody} from '../src/embeddings/chunker.ts';

test('chunkBody', async t => {
  await t.test('short body passes through as one chunk', t => {
    const body = 'just one paragraph of text';
    const out = chunkBody(body);
    t.equal(out.length, 1, 'single chunk');
    t.equal(out[0], body, 'identical to input');
  });

  await t.test('empty body yields a single empty chunk', t => {
    const out = chunkBody('');
    t.equal(out.length, 1, 'one chunk');
    t.equal(out[0], '', 'empty content');
  });

  await t.test('header-bounded sections are separate chunks', t => {
    const body = `## A\n\n${'a'.repeat(800)}\n\n## B\n\n${'b'.repeat(800)}`;
    const out = chunkBody(body, {maxChars: 1000});
    t.equal(out.length, 2, 'two chunks (one per section)');
    t.ok(out[0]!.startsWith('A\n\n'), 'first chunk has section A header path');
    t.ok(out[1]!.startsWith('B\n\n'), 'second chunk has section B header path');
  });

  await t.test('within a section, paragraphs accumulate up to maxChars', t => {
    const body = `## S\n\n${'a'.repeat(400)}\n\n${'b'.repeat(400)}\n\n${'c'.repeat(400)}`;
    const out = chunkBody(body, {maxChars: 1000});
    t.ok(out.length >= 2, 'splits into multiple chunks');
    for (const c of out) t.ok(c.length <= 1500, `chunk under hard cap (got ${c.length})`);
  });

  await t.test('a single oversized paragraph is hard-split with overlap', t => {
    const body = 'x'.repeat(5000);
    const out = chunkBody(body, {maxChars: 1200});
    t.ok(out.length >= 4, 'split into multiple chunks');
    for (const c of out) t.ok(c.length <= 1500, `chunk respects hard cap (got ${c.length})`);
    // Char-level overlap means rejoining > original length; with overlap
    // disabled the pieces sum to the original body.
    const noOverlap = chunkBody(body, {maxChars: 1200, overlap: false});
    t.equal(noOverlap.join('').length, body.length, 'no overlap → pieces sum to body length');
  });

  await t.test('paragraph-level overlap in same section', t => {
    const para = (n: number, char: string): string => char.repeat(n);
    const body = `## S\n\n${para(400, 'a')}\n\n${para(400, 'b')}\n\n${para(400, 'c')}\n\n${para(400, 'd')}`;
    const out = chunkBody(body, {maxChars: 1000});
    t.ok(out.length >= 2, 'splits into multiple chunks');
    // The repeated middle paragraph should appear in two consecutive chunks.
    const allText = out.join('\n---\n');
    const aaaCount = (allText.match(/a{400}/g) ?? []).length;
    const bbbCount = (allText.match(/b{400}/g) ?? []).length;
    const cccCount = (allText.match(/c{400}/g) ?? []).length;
    t.equal(aaaCount, 1, '"a" paragraph appears once');
    t.ok(bbbCount >= 2 || cccCount >= 2, 'a middle paragraph appears in adjacent chunks (overlap)');
  });

  await t.test('overlap does NOT cross a header boundary', t => {
    const body = `## A\n\n${'a'.repeat(600)}\n\n## B\n\n${'b'.repeat(600)}`;
    const out = chunkBody(body, {maxChars: 800});
    const second = out[1] ?? '';
    t.notOk(
      second.includes('aaaaa'),
      'second chunk (section B) does not include section A content'
    );
  });

  await t.test('nested header path is preserved on each chunk', t => {
    const body = `# Top\n\n## Middle\n\n${'p'.repeat(2000)}`;
    const out = chunkBody(body, {maxChars: 1000});
    t.ok(out.length >= 2, 'splits across multiple chunks');
    for (const c of out) t.ok(c.startsWith('Top / Middle\n\n'), 'header path on each chunk');
  });

  await t.test('code fences are kept intact within a single block', t => {
    const code =
      '```js\n' + Array.from({length: 30}, (_, i) => `const x${i} = ${i};`).join('\n') + '\n```';
    const body = `## S\n\nIntro paragraph.\n\n${code}\n\nOutro paragraph.`;
    const out = chunkBody(body, {maxChars: 2000});
    const fenceCount = out.reduce((n, c) => n + (c.match(/```/g)?.length ?? 0), 0);
    t.equal(fenceCount % 2, 0, 'fence delimiters are paired across the chunks');
  });

  await t.test('summary is prepended to every chunk', t => {
    const summary = 'TLDR — concise distillation.';
    const body = `## A\n\n${'a'.repeat(800)}\n\n## B\n\n${'b'.repeat(800)}`;
    const out = chunkBody(body, {maxChars: 1000, summary});
    t.equal(out.length, 2, 'one chunk per section');
    for (const chunk of out) {
      t.ok(chunk.startsWith(`${summary}\n\n`), 'chunk leads with summary prefix');
    }
  });

  await t.test('summary prepended on hard-split single paragraph too', t => {
    const summary = 'TLDR.';
    const body = 'a'.repeat(3000); // hard-split path (no headers, > HARD_CAP)
    const out = chunkBody(body, {maxChars: 1500, summary});
    t.ok(out.length >= 2, 'multi-chunk via hard-split');
    for (const chunk of out)
      t.ok(chunk.startsWith(`${summary}\n\n`), 'each chunk has summary prefix');
  });

  await t.test('null/empty summary is a no-op (no prefix added)', t => {
    const body = 'just one paragraph';
    const a = chunkBody(body, {summary: null});
    const b = chunkBody(body, {summary: ''});
    const c = chunkBody(body);
    t.deepEqual(a, c, 'null summary === no summary');
    t.deepEqual(b, c, 'empty summary === no summary');
  });
});
