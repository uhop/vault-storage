import test from 'tape-six';
import {DEFAULT_STATUS, remapStatus} from '../src/migration/status.ts';

test('legacy status synonyms collapse to canonical values', t => {
  t.equal(remapStatus('done'), 'done', 'done → done');
  t.equal(remapStatus('completed'), 'done', 'completed → done');
  t.equal(remapStatus('shipped'), 'done', 'shipped → done');
  t.equal(remapStatus('processed'), 'done', 'processed → done');
  t.equal(remapStatus('done-round-1'), 'done', 'done-round-1 → done');
});

test('lifecycle states preserved', t => {
  t.equal(remapStatus('active'), 'active', 'active stays');
  t.equal(remapStatus('superseded'), 'superseded', 'superseded stays');
  t.equal(remapStatus('archived'), 'archived', 'archived stays');
  t.equal(remapStatus('archive'), 'archived', 'archive → archived');
});

test('in-progress / paused → active (operational, not lifecycle)', t => {
  t.equal(remapStatus('in-progress'), 'active', 'in-progress → active');
  t.equal(remapStatus('paused'), 'active', 'paused → active');
});

test('stub / idea / design (legacy status sense) → draft', t => {
  t.equal(remapStatus('stub'), 'draft', 'stub → draft');
  t.equal(remapStatus('idea'), 'draft', 'idea → draft');
  t.equal(remapStatus('design'), 'draft', 'design → draft');
});

test('unknown / missing / non-string → DEFAULT_STATUS', t => {
  t.equal(remapStatus(undefined), DEFAULT_STATUS, 'undefined → default');
  t.equal(remapStatus(null), DEFAULT_STATUS, 'null → default');
  t.equal(remapStatus(''), DEFAULT_STATUS, 'empty string → default');
  t.equal(remapStatus('whatever'), DEFAULT_STATUS, 'unknown → default');
  t.equal(remapStatus(42 as unknown), DEFAULT_STATUS, 'non-string → default');
});

test('case- and whitespace-insensitive matching', t => {
  t.equal(remapStatus('DONE'), 'done', 'uppercase → done');
  t.equal(remapStatus('  done  '), 'done', 'padded → done');
});
