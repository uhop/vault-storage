import test from 'tape-six';
import {mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseFrontmatter} from '../src/markdown/frontmatter.ts';
import {
  atomizeVault,
  decideAtomization,
  slugifyHeading,
  splitFile,
  splitTopLevelSections
} from '../src/migration/atomize.ts';

const writeMd = (root: string, relativePath: string, content: string): void => {
  const abs = join(root, relativePath);
  mkdirSync(abs.replace(/\/[^/]+$/, ''), {recursive: true});
  writeFileSync(abs, content, 'utf8');
};

const setupTree = (): {root: string; cleanup: () => void} => {
  const root = mkdtempSync(join(tmpdir(), 'vault-atomize-test-'));
  return {root, cleanup: () => rmSync(root, {recursive: true, force: true})};
};

test('splitTopLevelSections splits on `## ` headings', t => {
  const body = '## A\nfirst\n\n## B\nsecond\n## C\nthird\n';
  const sections = splitTopLevelSections(body);
  t.equal(sections.length, 3, 'three sections');
  t.equal(sections[0]?.heading, 'A', 'first heading A');
  t.equal(sections[1]?.heading, 'B', 'second heading B');
  t.equal(sections[2]?.heading, 'C', 'third heading C');
  t.equal(sections[0]?.body.trim(), 'first', 'A body');
});

test('splitTopLevelSections returns empty when no `## ` heading exists', t => {
  t.deepEqual(splitTopLevelSections('plain body, no headings'), [], 'no sections');
  t.deepEqual(
    splitTopLevelSections('# H1 only\nbody'),
    [],
    'H1 alone is not a section boundary'
  );
});

test('slugifyHeading: kebab-case ASCII', t => {
  t.equal(slugifyHeading('API design'), 'api-design', 'simple');
  t.equal(slugifyHeading('Authentication & authorization'), 'authentication-authorization', 'punctuation');
  t.equal(slugifyHeading('café résumé'), 'cafe-resume', 'accent strip');
  t.equal(slugifyHeading('  --hello--  '), 'hello', 'trim dashes');
});

test('decideAtomization: respects byte and section thresholds', t => {
  const small = decideAtomization('short body', {});
  t.equal(small.atomize, false, 'small body stays');

  const big = 'x'.repeat(40_000);
  const fewSections = decideAtomization(`## a\n${big}\n## b\n`, {});
  t.equal(fewSections.atomize, false, 'big body but only 2 sections stays');

  const manyShort = '## h\n' + Array.from({length: 10}, (_, i) => `## h${i}\nbody\n`).join('');
  t.equal(decideAtomization(manyShort, {}).atomize, false, 'many sections but small body stays');

  const sectionsBody = Array.from({length: 7}, (_, i) => `## h${i}\n${'x'.repeat(5_000)}\n`).join('');
  t.equal(decideAtomization(sectionsBody, {}).atomize, true, 'big AND >5 sections atomizes');
});

test('decideAtomization: `atomize: false` opts out', t => {
  const big = Array.from({length: 7}, (_, i) => `## h${i}\n${'x'.repeat(5_000)}\n`).join('');
  const decision = decideAtomization(big, {atomize: false});
  t.equal(decision.atomize, false, 'atomize: false opts out');
  t.ok(decision.reason.includes('opt-out'), 'reason cites opt-out');
});

test('splitFile: produces piece files + _about.md', t => {
  const source = [
    '---',
    'title: Decisions',
    'tags: [demo]',
    'type: design',
    '---',
    '## API design',
    'API decision body.',
    '',
    '## Auth flow',
    'Auth decision body.',
    ''
  ].join('\n');

  const result = splitFile({relativePath: 'projects/demo/decisions.md', source});

  t.equal(result.pieces.length, 2, 'two pieces');
  t.equal(
    result.pieces[0]?.relativePath,
    'projects/demo/decisions/api-design.md',
    'first piece path'
  );
  t.equal(
    result.pieces[1]?.relativePath,
    'projects/demo/decisions/auth-flow.md',
    'second piece path'
  );

  const piece0Fm = parseFrontmatter(result.pieces[0]!.content).data;
  t.equal(piece0Fm['title'], 'API design', 'piece title from heading');
  t.equal(piece0Fm['type'], 'design', 'type inherited');
  t.deepEqual(piece0Fm['tags'], ['demo'], 'tags inherited');
  t.equal(piece0Fm['sequence_key'], 1, 'sequence_key set');

  t.equal(result.about?.relativePath, 'projects/demo/decisions/_about.md', 'about path');
  const aboutFm = parseFrontmatter(result.about!.content).data;
  t.equal(aboutFm['title'], 'Decisions', 'about title from source');
  t.equal(aboutFm['type'], 'meta', 'about type meta');
});

test('splitFile: pieces of legacy running files get specific type override', t => {
  const sectionsBody = '## A\nbody\n## B\nbody\n';
  const decSource = ['---', 'title: Decisions', 'type: project', '---', sectionsBody].join('\n');
  const decResult = splitFile({relativePath: 'projects/blog/decisions.md', source: decSource});
  const piece = parseFrontmatter(decResult.pieces[0]!.content).data;
  t.equal(piece['type'], 'design', 'decisions.md piece → type=design');

  const learnSource = ['---', 'title: Learnings', 'type: project', '---', sectionsBody].join('\n');
  const learnResult = splitFile({
    relativePath: 'projects/blog/learnings.md',
    source: learnSource
  });
  const lpiece = parseFrontmatter(learnResult.pieces[0]!.content).data;
  t.equal(lpiece['type'], 'research', 'learnings.md piece → type=research');

  const queueSource = ['---', 'type: project', '---', sectionsBody].join('\n');
  const queueResult = splitFile({
    relativePath: 'projects/blog/queue.md',
    source: queueSource
  });
  const qpiece = parseFrontmatter(queueResult.pieces[0]!.content).data;
  t.equal(qpiece['type'], 'queue-item', 'queue.md piece → type=queue-item');
});

test('splitFile: deeper-path source keeps inherited type', t => {
  // `projects/<name>/design/<file>.md` is already in the right folder; the
  // pieces should keep the inherited type rather than mis-mapping based on stem.
  const sectionsBody = '## A\nbody\n## B\nbody\n';
  const source = ['---', 'type: design', '---', sectionsBody].join('\n');
  const result = splitFile({
    relativePath: 'projects/blog/design/playbash-design.md',
    source
  });
  const piece = parseFrontmatter(result.pieces[0]!.content).data;
  t.equal(piece['type'], 'design', 'inherited type preserved');
});

test('splitFile: deeper-path source with mis-typed source FM gets path-derived type', t => {
  // `projects/<name>/design/<file>.md` with explicit `type: project` should
  // still produce pieces typed as `design` — the path is more reliable than
  // the source's catch-all type. Caught on the live-vault deploy: constraints.md
  // had type=project but its pieces should be design.
  const sectionsBody = '## A\nbody\n## B\nbody\n';
  const source = ['---', 'type: project', '---', sectionsBody].join('\n');
  const result = splitFile({
    relativePath: 'projects/vault-storage/design/constraints.md',
    source
  });
  const piece = parseFrontmatter(result.pieces[0]!.content).data;
  t.equal(piece['type'], 'design', 'path overrides catch-all `project` type');
});

test('splitFile: dedupes slug collisions', t => {
  const source = ['## Same\nfirst\n', '## same\nsecond\n', '## SAME\nthird\n'].join('\n');
  const result = splitFile({relativePath: 'a.md', source});
  const paths = result.pieces.map(p => p.relativePath);
  t.ok(paths[0]?.endsWith('/same.md'), 'first uses base slug');
  t.ok(paths[1]?.endsWith('/same-2.md'), 'second appends -2');
  t.ok(paths[2]?.endsWith('/same-3.md'), 'third appends -3');
});

test('atomizeVault: splits oversized files in place, deletes originals', t => {
  const {root, cleanup} = setupTree();
  try {
    const sectionsBody = Array.from(
      {length: 7},
      (_, i) => `## Section ${i + 1}\n${'lorem '.repeat(1_000)}\n`
    ).join('');
    writeMd(
      root,
      'projects/demo/decisions.md',
      ['---', 'title: Decisions', 'tags: [demo]', 'type: design', '---', sectionsBody].join('\n')
    );
    writeMd(root, 'topics/small.md', '---\ntitle: Small\n---\nbody\n');

    const summary = atomizeVault(root);
    t.equal(summary.atomized, 1, 'one file atomized');
    t.equal(summary.piecesWritten, 7, 'seven pieces');

    t.equal(
      existsSync(join(root, 'projects/demo/decisions.md')),
      false,
      'original deleted'
    );
    t.equal(
      existsSync(join(root, 'projects/demo/decisions/_about.md')),
      true,
      'about written'
    );
    t.equal(
      existsSync(join(root, 'projects/demo/decisions/section-1.md')),
      true,
      'piece 1 written'
    );
    t.equal(existsSync(join(root, 'topics/small.md')), true, 'small file kept');
  } finally {
    cleanup();
  }
});

test('atomizeVault: respects atomize: false opt-out', t => {
  const {root, cleanup} = setupTree();
  try {
    const sectionsBody = Array.from(
      {length: 7},
      (_, i) => `## Section ${i + 1}\n${'x'.repeat(5_000)}\n`
    ).join('');
    writeMd(
      root,
      '_index.md',
      ['---', 'title: Index', 'atomize: false', '---', sectionsBody].join('\n')
    );

    const summary = atomizeVault(root);
    t.equal(summary.atomized, 0, 'no files atomized');
    t.equal(summary.optedOut, 1, 'one file opted out');
    t.equal(existsSync(join(root, '_index.md')), true, 'index preserved');
  } finally {
    cleanup();
  }
});
