// <vault-markdown value="..." show-frontmatter>
//
// Renders markdown via the vendored `marked` bundle with a wikilink
// extension: `[[topics/foo]]` and `[[topics/foo|alias]]` become
// <a class="wikilink" data-wikilink="..."> elements that the component
// then resolves in one POST /resolve per render, caching hits and misses
// for the lifetime of the element. Resolved links get an `href`
// (so middle-click / cmd-click / ctrl-click open in a new tab as native
// <a>); unresolved links get an `.unresolved` class for line-through
// styling and no href.
//
// Attributes:
//   value           markdown source (string).
//   show-frontmatter present → render the YAML front-matter block as a
//                   compact <pre class="frontmatter"> above the body.
//                   Absent → strip front-matter from the rendered output.
//
// The component renders into light DOM (no shadow root) so host pages
// can style .preview / .wikilink / .frontmatter from their own CSS. For
// the host pages that need rendered markdown, that's the right tradeoff
// — shared CSS with the rest of the page.
//
// Auth: reads the bearer token from localStorage key `vault.token` (the
// project's single-user single-token convention). If absent, wikilink
// resolution is skipped — links render as raw <a> elements without href.

import {marked} from '../vendor/marked.esm.js';

const esc = s =>
  String(s).replace(
    /[<>&"']/g,
    c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'})[c]
  );

const splitFrontmatter = text => {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  return m ? {fm: m[1], body: m[2]} : {fm: null, body: text};
};

let markedConfigured = false;
const configureMarked = () => {
  if (markedConfigured) return;
  marked.use({
    extensions: [
      {
        name: 'wikilink',
        level: 'inline',
        start(src) {
          const i = src.indexOf('[[');
          return i === -1 ? undefined : i;
        },
        tokenizer(src) {
          const m = /^\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/.exec(src);
          if (m) {
            return {
              type: 'wikilink',
              raw: m[0],
              target: m[1],
              alias: m[2] ?? null
            };
          }
          return undefined;
        },
        renderer(token) {
          const display = token.alias ?? token.target;
          return `<a class="wikilink" data-wikilink="${esc(token.target)}">${esc(display)}</a>`;
        }
      }
    ]
  });
  marked.setOptions({gfm: true, breaks: false});
  markedConfigured = true;
};

const BATCH = 200; // the server caps a batch at 500

class VaultMarkdown extends HTMLElement {
  static observedAttributes = ['value', 'show-frontmatter'];

  #cache = new Map();
  #renderToken = 0;

  constructor() {
    super();
    configureMarked();
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback(name, oldValue, newValue) {
    // Re-setting the same value would re-parse the whole document for nothing.
    if (oldValue === newValue) return;
    if (this.isConnected) this.render();
  }

  set value(v) {
    this.setAttribute('value', v);
  }
  get value() {
    return this.getAttribute('value') ?? '';
  }

  render() {
    const text = this.value;
    const showFm = this.hasAttribute('show-frontmatter');
    const {fm, body} = splitFrontmatter(text);
    let html = '';
    if (showFm && fm) html = `<pre class="frontmatter">${esc(fm)}</pre>`;
    html += marked.parse(body);
    this.innerHTML = html;
    this.#renderToken++;
    this.#decorateWikilinks(this.#renderToken);
  }

  async #decorateWikilinks(token) {
    const links = [...this.querySelectorAll('a.wikilink')].filter(a => a.dataset.wikilink);
    if (links.length === 0) return;
    const auth = localStorage.getItem('vault.token');
    if (!auth) return;
    const pending = new Set();
    for (const a of links) {
      a.classList.add('resolving');
      if (!this.#cache.has(a.dataset.wikilink)) pending.add(a.dataset.wikilink);
    }
    await this.#resolve([...pending], auth);
    // Discard if a newer render has happened — the elements we
    // captured may already be detached from the DOM.
    if (token !== this.#renderToken) return;
    for (const a of links) {
      const data = this.#cache.get(a.dataset.wikilink);
      a.classList.remove('resolving');
      if (data) {
        a.href = data.ui_url;
        a.title = data.file_path;
      } else {
        a.classList.add('unresolved');
        a.title = 'Wikilink not resolved';
      }
    }
  }

  // A failed request caches nothing, so the next render retries it.
  async #resolve(targets, auth) {
    const chunks = [];
    for (let i = 0; i < targets.length; i += BATCH) chunks.push(targets.slice(i, i + BATCH));
    await Promise.all(
      chunks.map(async chunk => {
        let items;
        try {
          const res = await fetch('/resolve', {
            method: 'POST',
            headers: {Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json'},
            body: JSON.stringify({wikilinks: chunk})
          });
          if (!res.ok) return;
          ({items} = await res.json());
        } catch {
          return;
        }
        chunk.forEach((target, i) => this.#cache.set(target, items[i]?.ui_url ? items[i] : null));
      })
    );
  }
}

customElements.define('vault-markdown', VaultMarkdown);
