import test from 'tape-six';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanRawInbox} from '../src/maintenance/raw-inbox.ts';

const setup = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'vault-raw-inbox-'));
  mkdirSync(join(root, 'raw'));
  return root;
};

const writeRaw = (root: string, name: string, body: string): void => {
  writeFileSync(join(root, 'raw', name), body, 'utf8');
};

test('scanRawInbox: empty raw/ returns empty buckets', t => {
  const root = setup();
  try {
    const r = scanRawInbox(root);
    t.deepEqual(r, {ready: [], drafts: []});
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('scanRawInbox: missing raw/ returns empty buckets (no throw)', t => {
  const root = mkdtempSync(join(tmpdir(), 'vault-raw-inbox-empty-'));
  try {
    const r = scanRawInbox(root);
    t.deepEqual(r, {ready: [], drafts: []});
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('scanRawInbox: classifies notes by ready: true frontmatter flag', t => {
  const root = setup();
  try {
    writeRaw(root, 'a.md', '---\ntitle: Note A\nready: true\nupdated: 2026-05-01\n---\nbody\n');
    writeRaw(root, 'b.md', '---\ntitle: Note B\nupdated: 2026-04-30\n---\nstill drafting\n');
    writeRaw(root, 'c.md', 'no frontmatter, just text\n');
    writeRaw(root, 'd.md', '---\ntitle: Note D\nready: false\n---\nexplicit not-ready\n');
    writeRaw(root, '_about.md', '---\ntitle: About\n---\nmeta\n');

    const r = scanRawInbox(root);
    t.equal(r.ready.length, 1);
    t.equal(r.ready[0]?.path, 'raw/a.md');
    t.equal(r.ready[0]?.title, 'Note A');
    t.equal(r.ready[0]?.updated, '2026-05-01');

    const draftPaths = r.drafts.map(d => d.path).sort();
    t.deepEqual(draftPaths, ['raw/b.md', 'raw/c.md', 'raw/d.md']);
    const noFm = r.drafts.find(d => d.path === 'raw/c.md');
    t.equal(noFm?.title, null, 'no-FM file → null title');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('scanRawInbox: skips _about.md and archive/', t => {
  const root = setup();
  try {
    writeRaw(root, '_about.md', '---\ntitle: About\n---\nmeta\n');
    mkdirSync(join(root, 'raw', 'archive'));
    writeFileSync(
      join(root, 'raw', 'archive', 'old.md'),
      '---\ntitle: Old\nready: true\n---\nprocessed\n'
    );
    writeRaw(root, 'live.md', '---\ntitle: Live\nready: true\n---\nready\n');

    const r = scanRawInbox(root);
    t.equal(r.ready.length, 1, 'archive/ contents are not surfaced');
    t.equal(r.ready[0]?.path, 'raw/live.md');
    t.equal(r.drafts.length, 0);
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('scanRawInbox: malformed YAML treated as draft (silently)', t => {
  const root = setup();
  try {
    // Sufficiently malformed to skip parseFrontmatter's path entirely
    // (no leading --- block) — body-only is the legacy raw shape.
    writeRaw(root, 'broken.md', '---\nthis is not: : : valid\n---\nbody\n');
    writeRaw(root, 'good.md', '---\ntitle: Good\nready: true\n---\nbody\n');

    const r = scanRawInbox(root);
    t.equal(r.ready.length, 1, 'good note classified ready');
    // Malformed YAML still yields a draft entry (we never throw on FM parse).
    const broken = r.drafts.find(d => d.path === 'raw/broken.md');
    t.ok(broken, 'broken note surfaces as draft');
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});

test('scanRawInbox: results sorted by path', t => {
  const root = setup();
  try {
    writeRaw(root, 'z.md', '---\nready: true\n---\n');
    writeRaw(root, 'a.md', '---\nready: true\n---\n');
    writeRaw(root, 'm.md', '---\nready: true\n---\n');

    const r = scanRawInbox(root);
    t.deepEqual(
      r.ready.map(i => i.path),
      ['raw/a.md', 'raw/m.md', 'raw/z.md']
    );
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
});
