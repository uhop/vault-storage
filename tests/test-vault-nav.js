import test from 'tape-six';

import {buildNav} from '/static/ui/components/vault-nav.js';

// The canonical menu — index.html's pre-component nav, the one page that had
// the full list (agents.html lacked "note", every other page lacked "agents").
const CANON = [
  ['/ui/search.html', 'search'],
  ['/ui/projects.html', 'projects'],
  ['/ui/tags.html', 'tags'],
  ['/ui/raw.html', 'raw'],
  ['/ui/folder.html', 'browse'],
  ['/ui/note.html', 'note'],
  ['/ui/agents.html', 'agents']
];

test('vault-nav renders the full canonical menu on every page', t => {
  for (const [pathname] of CANON) {
    const nav = buildNav(pathname);
    t.equal(nav.tagName, 'NAV', 'renders a plain <nav>');
    const links = [...nav.querySelectorAll('a')].map(a => [a.getAttribute('href'), a.textContent]);
    t.deepEqual(links, CANON, `full menu, canonical order on ${pathname}`);
  }
});

test('vault-nav marks exactly the current page', t => {
  for (const [pathname, label] of CANON) {
    const marked = [...buildNav(pathname).querySelectorAll('a[aria-current="page"]')];
    t.equal(marked.length, 1, `exactly one aria-current on ${pathname}`);
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
