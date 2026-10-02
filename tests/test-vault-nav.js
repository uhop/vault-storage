import test from 'tape-six';

import {buildNav} from '/static/ui/components/vault-nav.js';

// The canonical menu by group (D134): every page the nav reaches, in order.
const GROUPS = [
  [
    'notes',
    [
      ['/ui/search.html', 'search'],
      ['/ui/folder.html', 'browse'],
      ['/ui/raw.html', 'raw'],
      ['/ui/edit.html', 'new note'],
      ['/ui/drafts.html', 'drafts']
    ]
  ],
  [
    'graph',
    [
      ['/ui/tags.html', 'tags'],
      ['/ui/edges.html', 'edges'],
      ['/ui/neighborhood.html', 'neighborhood']
    ]
  ],
  [
    'fleet',
    [
      ['/ui/projects.html', 'projects'],
      ['/ui/fleet.html', 'fleet'],
      ['/ui/fleet.html?view=packages', 'packages'],
      ['/ui/agents.html', 'agents']
    ]
  ],
  [
    'upkeep',
    [
      ['/ui/lint-review.html', 'lint review'],
      ['/ui/archive-review.html', 'archive review'],
      ['/ui/keys.html', 'keys']
    ]
  ]
];
const CANON = GROUPS.flatMap(([, items]) => items);

const locationOf = href => {
  const url = new URL(href, 'http://ui.invalid');
  return [url.pathname, url.search];
};

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('vault-nav renders every group and every item on every page', t => {
  for (const [href] of CANON) {
    const nav = buildNav(...locationOf(href));
    t.equal(nav.tagName, 'NAV', 'renders a plain <nav>');
    const groups = [...nav.querySelectorAll('details')].map(d => [
      d.querySelector('summary').textContent,
      [...d.querySelectorAll('a')].map(a => [a.getAttribute('href'), a.textContent])
    ]);
    t.deepEqual(groups, GROUPS, `groups and items in order on ${href}`);
    t.equal(nav.querySelectorAll('details[open]').length, 0, 'every group starts closed');
  }
});

test('vault-nav marks exactly the current page and its group', t => {
  for (const [group, items] of GROUPS) {
    for (const [href, label] of items) {
      const nav = buildNav(...locationOf(href));
      const marked = [...nav.querySelectorAll('a[aria-current="page"]')];
      t.equal(marked.length, 1, `exactly one aria-current on ${href}`);
      t.equal(marked[0].textContent, label, `the marked item is ${label}`);
      const current = [...nav.querySelectorAll('details.current')];
      t.equal(current.length, 1, `exactly one current group on ${href}`);
      t.equal(current[0].querySelector('summary').textContent, group, `the group is ${group}`);
    }
  }
});

test('vault-nav marks nothing on the dashboard and unknown paths', t => {
  for (const pathname of ['/ui/', '/ui/index.html', '/nowhere', '/ui/note.html']) {
    const nav = buildNav(pathname);
    t.equal(nav.querySelectorAll('a[aria-current]').length, 0, `no aria-current on ${pathname}`);
    t.equal(nav.querySelectorAll('details.current').length, 0, `no current group on ${pathname}`);
  }
});

test('vault-nav does not mark "new note" while the editor holds a note', t => {
  const marked = search =>
    [...buildNav('/ui/edit.html', search).querySelectorAll('a[aria-current]')].map(
      a => a.textContent
    );
  t.deepEqual(marked(''), ['new note']);
  t.deepEqual(marked('?path=topics%2Falpha.md'), [], 'an existing note');
});

test('vault-nav element builds once and reconnect is a no-op', t => {
  const el = document.createElement('vault-nav');
  document.body.appendChild(el);
  try {
    t.equal(el.querySelectorAll('nav').length, 1, 'one nav after connect');
    t.equal(el.querySelectorAll('a').length, CANON.length, 'all items rendered');

    el.remove();
    document.body.appendChild(el);
    t.equal(el.querySelectorAll('nav').length, 1, 'still one nav after reconnect');
  } finally {
    el.remove();
  }
});

test('vault-nav picks the most specific item for a shared path', t => {
  const marked = (pathname, search) =>
    [...buildNav(pathname, search).querySelectorAll('a[aria-current]')].map(a => a.textContent);
  t.deepEqual(marked('/ui/fleet.html', ''), ['fleet']);
  t.deepEqual(marked('/ui/fleet.html', '?view=packages'), ['packages']);
  t.deepEqual(marked('/ui/fleet.html', '?view=repos'), ['fleet'], 'another view is the plain page');
  t.deepEqual(
    marked('/ui/fleet.html', '?view=packages&x=1'),
    ['packages'],
    'extra params still match'
  );
});

test('vault-nav refresh re-marks for a changed query', t => {
  const el = document.createElement('vault-nav');
  document.body.appendChild(el);
  const marked = () => [...el.querySelectorAll('a[aria-current]')].map(a => a.textContent);
  try {
    el.refresh('/ui/fleet.html', '?view=packages');
    t.deepEqual(marked(), ['packages']);
    el.refresh('/ui/fleet.html', '');
    t.deepEqual(marked(), ['fleet']);
  } finally {
    el.remove();
  }
});

test('vault-nav opens one group at a time and closes on a click outside or Escape', async t => {
  const el = document.createElement('vault-nav');
  document.body.appendChild(el);
  const [notes, graph] = el.querySelectorAll('details');
  const open = () => [...el.querySelectorAll('details[open]')].map(d => d.firstChild.textContent);
  try {
    notes.querySelector('summary').click();
    await tick();
    t.deepEqual(open(), ['notes'], 'a click on a group opens it');

    graph.querySelector('summary').click();
    await tick();
    t.deepEqual(open(), ['graph'], 'opening another closes the first');

    document.body.click();
    await tick();
    t.deepEqual(open(), [], 'a click outside closes it');

    graph.querySelector('summary').click();
    await tick();
    graph.querySelector('a').focus();
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
    await tick();
    t.deepEqual(open(), [], 'Escape closes it');
    t.equal(document.activeElement, graph.querySelector('summary'), 'focus returns to the group');
  } finally {
    el.remove();
  }
});
