import test from 'tape-six';

import {VIEWS, legendEntries} from '/static/ui/components/vault-legend.js';

// The chip styles fleet-popover.js defines, each of which the glance view explains.
const CHIP_KINDS = ['new', 'active', 'bot', 'draft', 'warn', 'bad'];

// The marks the tables print, each of which its view explains.
const TABLE_MARKS = {
  repos: [
    '&nbsp;',
    '>-<',
    '>off<',
    'no CVE',
    '≥',
    'cell fmw-ok',
    'cell fmw-bad',
    'cell fmw-warn',
    'cell fmw-quiet',
    '▲'
  ],
  packages: [
    '&nbsp;',
    '>-<',
    'class="x"',
    'deprecated',
    '≤',
    '<svg',
    'cell fmw-quiet',
    'cell fmw-warn',
    '▲'
  ],
  project: ['deprecated', '<svg', 'fmw-warn']
};

const mount = view => {
  const el = document.createElement('vault-legend');
  el.setAttribute('view', view);
  document.body.appendChild(el);
  return el;
};

test('vault-legend has entries for every view, each a mark and a sentence', t => {
  for (const view of VIEWS) {
    const entries = legendEntries(view);
    t.ok(entries.length > 0, `${view} has entries`);
    for (const e of entries) {
      t.ok(e.mark.length > 0, `${view}: a mark`);
      t.ok(e.text.endsWith('.'), `${view}: a sentence — ${e.text}`);
    }
  }
  t.deepEqual(legendEntries('nowhere'), [], 'an unknown view has none');
});

test('every chip style has a glance entry', t => {
  const marks = legendEntries('glance').map(e => e.mark);
  for (const kind of CHIP_KINDS)
    t.ok(
      marks.some(m => m.includes(`chip ${kind}`)),
      `chip.${kind}`
    );
  t.ok(
    marks.some(m => m.includes('"chip"')),
    'the plain chip'
  );
  t.ok(
    marks.some(m => m.includes('legend-line')),
    'the highlighted line'
  );
  t.ok(
    marks.some(m => m.includes('>stale<')),
    'the stale mark'
  );
});

test('every table and chart mark has an entry on its view', t => {
  for (const [view, marks] of Object.entries(TABLE_MARKS)) {
    const html = legendEntries(view)
      .map(e => e.mark)
      .join('\n');
    for (const m of marks) t.ok(html.includes(m), `${view}: ${m}`);
  }
});

test('vault-legend renders its view, re-renders on change, and builds once', t => {
  const el = mount('glance');
  try {
    t.equal(el.querySelectorAll('details').length, 1, 'one details');
    t.equal(el.querySelector('summary').textContent, 'Legend');
    t.equal(el.querySelectorAll('.panel > span').length, 2 * legendEntries('glance').length);
    t.equal(el.hidden, false);

    el.view = 'repos';
    t.equal(el.querySelectorAll('.panel > span').length, 2 * legendEntries('repos').length);
    t.equal(
      el.querySelector('.panel > span').innerHTML,
      legendEntries('repos')[0].mark,
      'the first mark is the view’s first entry'
    );

    el.view = 'nowhere';
    t.equal(el.querySelectorAll('.panel > span').length, 0, 'an unknown view renders nothing');
    t.equal(el.hidden, true, 'and hides the element');

    el.view = 'packages';
    el.remove();
    document.body.appendChild(el);
    t.equal(el.querySelectorAll('details').length, 1, 'still one details after reconnect');
  } finally {
    el.remove();
  }
});

test('vault-legend takes a view set before the upgrade and keeps the accessor', t => {
  const el = document.createElement('vault-legend');
  // The own data property a page creates by assigning `.view` before the module defines the element.
  Object.defineProperty(el, 'view', {value: 'repos', writable: true, configurable: true});
  // An exception inside a lifecycle callback is reported, never thrown to the caller.
  const errors = [];
  const onError = e => errors.push(e.message);
  window.addEventListener('error', onError);
  document.body.appendChild(el);
  window.removeEventListener('error', onError);
  try {
    t.deepEqual(errors, [], 'the upgrade reports no error');
    t.equal(el.getAttribute('view'), 'repos', 'the early value reaches the attribute');
    t.equal(el.querySelectorAll('.panel > span').length, 2 * legendEntries('repos').length);
    el.view = 'packages';
    t.equal(el.getAttribute('view'), 'packages', 'later assignments reach the accessor');
    t.equal(el.querySelectorAll('.panel > span').length, 2 * legendEntries('packages').length);
  } finally {
    el.remove();
  }
});

test('vault-legend closes on a click outside and on Escape, stays open on a click inside', t => {
  const el = mount('project');
  const details = el.querySelector('details');
  try {
    details.open = true;
    el.querySelector('.panel').dispatchEvent(new MouseEvent('click', {bubbles: true}));
    t.equal(details.open, true, 'a click inside keeps it open');

    document.body.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    t.equal(details.open, false, 'a click outside closes it');

    details.open = true;
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
    t.equal(details.open, false, 'Escape closes it');

    el.remove();
    details.open = true;
    document.body.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    t.equal(details.open, true, 'a removed element no longer listens');
  } finally {
    el.remove();
  }
});
