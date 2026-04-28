import test from 'tape-six';
import {contentHash} from '../src/util/hash.ts';
import {uuidv7} from '../src/util/uuid.ts';

test('contentHash returns 64-char lowercase hex sha256', t => {
  const h = contentHash('hello world');
  t.equal(h.length, 64, 'sha256 hex is 64 chars');
  t.ok(/^[0-9a-f]{64}$/.test(h), 'lowercase hex only');
  t.equal(
    h,
    'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    'matches the known sha256 of "hello world"'
  );
});

test('contentHash is deterministic and input-sensitive', t => {
  t.equal(contentHash('abc'), contentHash('abc'), 'same input → same hash');
  t.notEqual(contentHash('abc'), contentHash('abd'), 'different input → different hash');
  t.notEqual(contentHash(''), contentHash(' '), 'empty vs whitespace differs');
});

test('uuidv7 has the correct format', t => {
  const id = uuidv7();
  t.equal(id.length, 36, 'canonical 36-char form');
  t.ok(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id),
    'matches 8-4-4-4-12 hex pattern'
  );
});

test('uuidv7 sets version 7 and the RFC 9562 variant', t => {
  const id = uuidv7();
  t.equal(id[14], '7', 'version nibble is 7');
  const variantNibble = parseInt(id[19] ?? '', 16);
  t.ok(variantNibble >= 0x8 && variantNibble <= 0xb, 'variant top bits are 10');
});

test('uuidv7 produces unique values', t => {
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) ids.add(uuidv7());
  t.equal(ids.size, 100, '100 calls produce 100 distinct UUIDs');
});

test('uuidv7 is lexicographically time-sortable across millisecond boundaries', async t => {
  const a = uuidv7();
  await new Promise(r => setTimeout(r, 5));
  const b = uuidv7();
  await new Promise(r => setTimeout(r, 5));
  const c = uuidv7();
  t.ok(a < b, 'earlier UUID sorts before later one');
  t.ok(b < c, 'and again');
});
