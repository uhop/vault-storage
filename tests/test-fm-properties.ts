// Property-based tests for the YAML frontmatter seam (queue item 2026-07-29):
// serialize → parse identity over arbitrary FM objects, weighted toward the
// string classes that historically produced real authoring bugs, plus the
// union-merge laws of the write path. First counterexample found before the
// suite even ran: trailing-newline runs in string values were eaten by the
// block-scalar + trim + delimiter-regex combination (fixed same day —
// `blockQuote: false` in serializeFrontmatter).

import test from 'tape-six';
import fc from 'fast-check';
import 'tape-six-fast-check';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseFrontmatter, serializeFrontmatter} from '../src/markdown/frontmatter.ts';
import {
  AUTO_MANAGED_KEYS,
  FM_UNSET_SENTINEL,
  INDEXER_OVERRIDE_KEYS,
  writeSplitRecordToDisk
} from '../src/server/writer.ts';

// The quoting-trap corpus: colon-space prose, leading specials, hex / octal /
// bool / date shadows, document markers, anchors / tags / comments, quote
// styles, and whitespace edges (the trailing-newline runs are the 2026-08-04
// counterexample pinned as deterministic members).
const TRAP_STRINGS = [
  'colon: space',
  'a: b: c',
  '@leading',
  '*star',
  '- dash',
  '? question',
  ': colon',
  '&anchor',
  '!tag',
  '%directive',
  '#comment',
  '|literal',
  '>fold',
  '0x1f',
  '0o17',
  '007',
  '1e3',
  '.inf',
  '-.inf',
  '.nan',
  'true',
  'false',
  'yes',
  'no',
  'on',
  'off',
  'null',
  '~',
  '2026-01-01',
  '2026-08-04T20:00:00Z',
  '---',
  '...',
  '{flow}',
  '[seq]',
  "JS's apostrophe",
  '"quoted"',
  "'single'",
  ' leading space',
  'trailing space ',
  'multi\nline',
  'tab\tsep',
  'x\n\n',
  '\n',
  'a\nb\n\n\n',
  ''
];

const trapString = fc.constantFrom(...TRAP_STRINGS);
const anyString = fc.oneof(trapString, fc.string(), fc.string({unit: 'grapheme'}));
const leaf = fc.oneof(
  anyString,
  fc.integer(),
  fc.double({noNaN: true, noDefaultInfinity: true}),
  fc.boolean(),
  fc.constant(null)
);
// noNullPrototype: parsed YAML yields plain objects; a null-prototype input
// would fail deepStrictEqual on prototype identity, not on content.
const fmValue = fc.oneof(
  leaf,
  fc.array(leaf, {maxLength: 4}),
  fc.dictionary(fc.string({minLength: 1}), leaf, {maxKeys: 4, noNullPrototype: true})
);
const fmKey = fc.oneof(trapString, fc.string()).filter(k => k.length > 0 && k !== '__proto__');

// Production FM is never empty at this seam — the writer always stamps
// `updated` + `created` — so identity is scoped to non-empty objects. (With
// empty data serializeFrontmatter emits the bare body, and a body that itself
// opens with `---` would read back as frontmatter: inherent to the format,
// guarded at the write path by `malformed_double_frontmatter`.)
const fmData = fc.dictionary(fmKey, fmValue, {minKeys: 1, maxKeys: 8, noNullPrototype: true});

test('property: serializeFrontmatter → parseFrontmatter identity', async t => {
  await t.prop(
    [fmData, anyString],
    (data, body) => {
      const round = parseFrontmatter(serializeFrontmatter({data, body}));
      assert.deepStrictEqual(round.data, data);
      return round.body === body;
    },
    'parse(serialize({data, body})) recovers data and body exactly'
  );
});

// ─── union-merge laws through the real write path ────────────────────────────

const WORK = mkdtempSync(join(tmpdir(), 'vault-fm-props-'));
const NOW = '2026-08-04T12:00:00.000Z';
const TODAY = NOW.slice(0, 10);
let seq = 0;

// Keys the writer treats specially: silently dropped (indexer overrides),
// rejected (auto-managed), sanitized (tags), finalized (agent), or
// enum-validated (status / type / priority). The merge laws quantify over
// everything else.
const RESERVED = new Set([
  ...AUTO_MANAGED_KEYS,
  ...INDEXER_OVERRIDE_KEYS,
  'tags',
  'agent',
  'status',
  'type',
  'priority'
]);
const mergeKey = fmKey.filter(k => !RESERVED.has(k));
// Top-level null is rejected by design (the wipe class); the unset sentinel
// is the removal mechanism, exercised by its own property below.
const mergeValue = fmValue.filter(v => v !== null && v !== FM_UNSET_SENTINEL);
const mergeData = fc.dictionary(mergeKey, mergeValue, {
  minKeys: 1,
  maxKeys: 6,
  noNullPrototype: true
});

const write = (filePath: string, frontmatter: Record<string, unknown>) =>
  writeSplitRecordToDisk({
    filePath,
    frontmatter,
    body: 'Body.\n',
    vaultDataPath: WORK,
    existing: null,
    now: NOW
  });

test('property: FM merge is union-only with request precedence', async t => {
  await t.prop(
    [mergeData, mergeData],
    (a, b) => {
      const filePath = `notes/union-${++seq}.md`;
      write(filePath, a);
      const r = write(filePath, b);
      // Object.hasOwn, not `in` — fast-check generates prototype-named keys
      // ('valueOf', 'toString'), and `in` would walk the prototype chain.
      for (const k of Object.keys(b)) assert.deepStrictEqual(r.frontmatter[k], b[k]);
      for (const k of Object.keys(a)) {
        if (!Object.hasOwn(b, k)) assert.deepStrictEqual(r.frontmatter[k], a[k]);
      }
      assert.equal(r.frontmatter['updated'], TODAY);
      assert.equal(r.frontmatter['created'], TODAY);
      // The composed FM survives its own on-disk YAML round-trip.
      assert.deepStrictEqual(
        parseFrontmatter(readFileSync(r.absolutePath, 'utf8')).data,
        r.frontmatter
      );
      return true;
    },
    'request keys override, omitted keys persist, stamps land, disk round-trips'
  );
});

test('property: FM merge is idempotent', async t => {
  await t.prop(
    [mergeData, mergeData],
    (a, b) => {
      const filePath = `notes/idem-${++seq}.md`;
      write(filePath, a);
      const once = write(filePath, b);
      const twice = write(filePath, b);
      assert.deepStrictEqual(twice.frontmatter, once.frontmatter);
      return twice.etag === once.etag;
    },
    'writing the same request twice composes the same document'
  );
});

test('property: the unset sentinel removes exactly the named keys', async t => {
  await t.prop(
    [mergeData, mergeData],
    (a, b) => {
      const filePath = `notes/unset-${++seq}.md`;
      write(filePath, a);
      write(filePath, b);
      const named = [...new Set([...Object.keys(a), ...Object.keys(b)])];
      const r = write(filePath, Object.fromEntries(named.map(k => [k, FM_UNSET_SENTINEL])));
      for (const k of named) {
        assert.equal(Object.hasOwn(r.frontmatter, k), false, `key removed: ${k}`);
      }
      assert.deepStrictEqual(Object.keys(r.frontmatter).sort(), ['created', 'updated']);
      return true;
    },
    'unset-all leaves only the indexer stamps'
  );
});

test('fm-properties cleanup', t => {
  rmSync(WORK, {recursive: true, force: true});
  t.pass('scratch vault removed');
});
