import test from 'tape-six';
import {buildTagMap, canonicalizeTag, normalizeTag} from '../src/migration/tags.ts';

test('normalizeTag: lowercase + kebab + ASCII drop', t => {
  t.equal(normalizeTag('AWS'), 'aws', 'lowercase');
  t.equal(normalizeTag('Foo Bar'), 'foo-bar', 'space → dash');
  t.equal(normalizeTag('foo_bar'), 'foo-bar', 'underscore → dash');
  t.equal(normalizeTag('foo--bar'), 'foo-bar', 'collapse repeated dashes');
  t.equal(normalizeTag('-leading-trailing-'), 'leading-trailing', 'trim dashes');
  t.equal(normalizeTag('hello!world'), 'helloworld', 'drop non-[a-z0-9-]');
});

test('buildTagMap: identity-only when nothing to canonicalize', t => {
  const map = buildTagMap(['gotcha', 'aws', 'design']);
  t.equal(map.canonical.size, 3, 'three canonical tags');
  t.equal(map.aliases.size, 0, 'no aliases needed');
  t.equal(map.pluralCollapses.length, 0, 'no plural collapses');
});

test('buildTagMap: collapses singular/plural when both appear', t => {
  const map = buildTagMap(['gotcha', 'gotchas', 'log', 'logs', 'pattern']);
  t.equal(map.canonical.has('gotcha'), true, 'gotcha is canonical');
  t.equal(map.canonical.has('gotchas'), false, 'gotchas dropped');
  t.equal(map.canonical.has('log'), true, 'log is canonical');
  t.equal(map.canonical.has('logs'), false, 'logs dropped');
  t.equal(map.aliases.get('gotchas'), 'gotcha', 'alias gotchas → gotcha');
  t.equal(map.aliases.get('logs'), 'log', 'alias logs → log');
  t.equal(map.pluralCollapses.length, 2, 'two plural collapses recorded');
});

test('buildTagMap: leaves apparent-plural-without-singular alone', t => {
  // `aws` ends in `s` but `aw` is not present, so we keep `aws`.
  const map = buildTagMap(['aws', 'docs']);
  t.equal(map.canonical.has('aws'), true, 'aws stays');
  t.equal(map.canonical.has('docs'), true, 'docs stays (no `doc` partner)');
  t.equal(map.pluralCollapses.length, 0, 'no collapses');
});

test('buildTagMap: aliases the raw form when canonicalization changes', t => {
  const map = buildTagMap(['Foo Bar']);
  t.equal(map.canonical.has('foo-bar'), true, 'normalized canonical present');
  t.equal(map.aliases.get('Foo Bar'), 'foo-bar', 'alias raw → normalized');
});

test('buildTagMap: alias chain (raw → normalized → singular)', t => {
  // 'Logs' (raw) normalizes to 'logs'; `log` is also in the corpus, so plural
  // collapse should redirect 'Logs' all the way to 'log'.
  const map = buildTagMap(['Logs', 'log']);
  t.equal(map.canonical.has('log'), true, 'log canonical');
  t.equal(map.canonical.has('logs'), false, 'logs dropped');
  t.equal(map.aliases.get('Logs'), 'log', 'raw plural → singular through chain');
});

test('canonicalizeTag: resolves via alias map or normalized form', t => {
  const map = buildTagMap(['gotcha', 'gotchas']);
  t.equal(canonicalizeTag('gotchas', map), 'gotcha', 'plural → canonical');
  t.equal(canonicalizeTag('Gotchas', map), 'gotcha', 'normalized + canonical');
  t.equal(canonicalizeTag('newtag', map), 'newtag', 'unknown tag normalized but not aliased');
});
