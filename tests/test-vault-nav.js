import test from 'tape-six';

import {buildNav} from '/static/ui/components/vault-nav.js';

// The canonical menu — index.html's pre-component nav, the one page that had
// the full list (agents.html lacked "note", every other page lacked "agents").
const CANON = [
  ['/ui/search.html', 'search'],
  ['/ui/projects.html', 'projects'],
  ['/ui/fleet.html', 'fleet'],
  ['/ui/fleet.html?view=packages', 'packages'],
  ['/ui/tags.html', 'tags'],
  ['/ui/raw.html', 'raw'],
  ['/ui/folder.html', 'browse'],
  ['/ui/note.html', 'note'],
  ['/ui/agents.html', 'agents']
];

const locationOf = href => {
  const url = new URL(href, 'http://ui.invalid');
  return [url.pathname, url.search];
};

test('vault-nav renders the full canonical menu on every page', t => {
  for (const [href] of CANON) {
    const [pathname, search] = locationOf(href);
    const nav = buildNav(pathname, search);
    t.equal(nav.tagName, 'NAV', 'renders a plain <nav>');
    const links = [...nav.querySelectorAll('a')].map(a => [a.getAttribute('href'), a.textContent]);
    t.deepEqual(links, CANON, `full menu, canonical order on ${href}`);
  }
});

test('vault-nav marks exactly the current page', t => {
  for (const [href, label] of CANON) {
    const marked = [...buildNav(...locationOf(href)).querySelectorAll('a[aria-current="page"]')];
    t.equal(marked.length, 1, `exactly one aria-current on ${href}`);
    t.equal(marked[0].textContent, label, `the marked item is ${label}`);
    t.equal(marked[0].getAttribute('aria-current'), 'page', 'marked with aria-current="page"');
  }
});

test('vault-nav marks nothing on the dashboard and unknown paths', t => {
  for (const pathname of ['/ui/', '/ui/index.html', '/nowhere']) {
    const marked = buildNav(pathname).querySelectorAll('a[aria-current]');
    t.equal(marked.length, 0, `no aria-current on ${pathname}`);
  }
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
