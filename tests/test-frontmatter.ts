import test from 'tape-six';
import {parseFrontmatter, serializeFrontmatter} from '../src/markdown/frontmatter.ts';

test('parses a vault-style note', t => {
  const src = [
    '---',
    'title: Demo',
    'tags: [vault, demo]',
    'created: 2026-04-28',
    '---',
    '',
    'Body content here.',
    ''
  ].join('\n');

  const fm = parseFrontmatter(src);
  t.equal(fm.data['title'], 'Demo', 'title parsed');
  t.deepEqual(fm.data['tags'], ['vault', 'demo'], 'tags parsed as array');
  t.equal(fm.data['created'], '2026-04-28', 'created parsed as string');
  t.equal(fm.body, '\nBody content here.\n', 'body preserved verbatim');
});

test('returns empty data and the original text when no frontmatter', t => {
  const src = 'Just a plain note with no header block.\n';
  const fm = parseFrontmatter(src);
  t.deepEqual(fm.data, {}, 'data is empty');
  t.equal(fm.body, src, 'body is the original text');
});

test('handles CRLF line endings', t => {
  const src = '---\r\ntitle: x\r\n---\r\nbody';
  const fm = parseFrontmatter(src);
  t.equal(fm.data['title'], 'x', 'CRLF frontmatter parsed');
  t.equal(fm.body, 'body', 'body after CRLF terminator');
});

test('treats a non-object YAML root as empty data', t => {
  // YAML scalars and lists at the top level are not valid frontmatter for our purposes.
  const src = '---\n- one\n- two\n---\nbody';
  const fm = parseFrontmatter(src);
  t.deepEqual(fm.data, {}, 'top-level list is rejected');
  t.equal(fm.body, 'body', 'body still extracted');
});

test('serialize roundtrips parse for a typical record', t => {
  const original = [
    '---',
    'title: Roundtrip',
    'tags:',
    '  - a',
    '  - b',
    'status: active',
    '---',
    'Body.',
    ''
  ].join('\n');
  const reserialized = serializeFrontmatter(parseFrontmatter(original));
  const second = parseFrontmatter(reserialized);

  t.equal(second.data['title'], 'Roundtrip', 'title preserved through roundtrip');
  t.deepEqual(second.data['tags'], ['a', 'b'], 'tags preserved through roundtrip');
  t.equal(second.data['status'], 'active', 'status preserved through roundtrip');
  t.equal(second.body, 'Body.\n', 'body preserved through roundtrip');
});

test('serialize emits no frontmatter block when data is empty', t => {
  const out = serializeFrontmatter({data: {}, body: 'plain body\n'});
  t.equal(out, 'plain body\n', 'no leading --- block on empty data');
});
