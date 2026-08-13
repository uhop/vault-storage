// <vault-nav> — the shared top-level menu. Single source of truth for the item
// list: every page renders the same menu, with the current page marked from
// location.pathname (hand-written per-page copies drifted — agents.html lacked
// "note", every other page lacked "agents").
//
// Light DOM on purpose, same rationale as <vault-toolbar>: renders a plain
// <nav> child, so the host page's `header nav a` CSS applies unchanged.

const ITEMS = [
  {href: '/ui/search.html', label: 'search'},
  {href: '/ui/projects.html', label: 'projects'},
  {href: '/ui/tags.html', label: 'tags'},
  {href: '/ui/raw.html', label: 'raw'},
  {href: '/ui/folder.html', label: 'browse'},
  {href: '/ui/note.html', label: 'note'},
  {href: '/ui/agents.html', label: 'agents'}
];

// Exported for tests: the pathname is a parameter so every page can be checked.
export const buildNav = pathname => {
  const nav = document.createElement('nav');
  for (const {href, label} of ITEMS) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = label;
    if (pathname === href) a.setAttribute('aria-current', 'page');
    nav.appendChild(a);
  }
  return nav;
};

class VaultNav extends HTMLElement {
  connectedCallback() {
    if (this._ready) return;
    this._ready = true;
    this.appendChild(buildNav(location.pathname));
  }
}

customElements.define('vault-nav', VaultNav);
