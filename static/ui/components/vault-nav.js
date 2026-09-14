// <vault-nav> — the shared top-level menu. Single source of truth for the item
// list: every page renders the same menu, with the current page marked from
// location.pathname and, for an item whose href carries a query, location.search
// (hand-written per-page copies drifted — agents.html lacked "note", every other
// page lacked "agents").
//
// Light DOM on purpose, same rationale as <vault-toolbar>: renders a plain
// <nav> child, so the host page's `header nav a` CSS applies unchanged.

const ITEMS = [
  {href: '/ui/search.html', label: 'search'},
  {href: '/ui/projects.html', label: 'projects'},
  {href: '/ui/fleet.html', label: 'fleet'},
  {href: '/ui/fleet.html?view=packages', label: 'packages'},
  {href: '/ui/tags.html', label: 'tags'},
  {href: '/ui/raw.html', label: 'raw'},
  {href: '/ui/folder.html', label: 'browse'},
  {href: '/ui/note.html', label: 'note'},
  {href: '/ui/agents.html', label: 'agents'}
];

// Of the items on this path, the one whose query parameters all match, the most
// specific first: fleet.html?view=packages marks "packages", not "fleet".
const currentItem = (pathname, search) => {
  const params = new URLSearchParams(search);
  let best = null,
    bestSize = -1;
  for (const item of ITEMS) {
    const url = new URL(item.href, 'http://ui.invalid');
    if (url.pathname !== pathname) continue;
    const wanted = [...url.searchParams];
    if (wanted.every(([k, v]) => params.get(k) === v) && wanted.length > bestSize) {
      best = item;
      bestSize = wanted.length;
    }
  }
  return best;
};

const markCurrent = (nav, pathname, search) => {
  const current = currentItem(pathname, search);
  nav.querySelectorAll('a').forEach((a, i) => {
    if (ITEMS[i] === current) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
};

// Exported for tests: the location is a parameter so every page can be checked.
export const buildNav = (pathname, search = '') => {
  const nav = document.createElement('nav');
  for (const {href, label} of ITEMS) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    nav.appendChild(a);
  }
  markCurrent(nav, pathname, search);
  return nav;
};

class VaultNav extends HTMLElement {
  connectedCallback() {
    if (this._ready) return;
    this._ready = true;
    this.appendChild(buildNav(location.pathname, location.search));
  }

  // For a page that changes its query in place (history.replaceState).
  refresh(pathname = location.pathname, search = location.search) {
    const nav = this.querySelector('nav');
    if (nav) markCurrent(nav, pathname, search);
  }
}

customElements.define('vault-nav', VaultNav);
