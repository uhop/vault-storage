// <vault-settings> — the header's ⚙ settings button plus the shared API-token
// dialog (#auth-dlg), one implementation for every page: the hand-copied
// dialogs drifted (row-class rename, missing Enter-to-save on two pages, no
// button at all on agents.html). Light DOM per the house pattern; the dialog
// look lives in theme.css (`dlg-row` over `row` — archive-review's generic
// .row list class collides otherwise). Saving stores the token and dispatches
// a bubbling `token-change` — the page's refresh-after-auth hook. api.js's
// showAuthDialog() keeps working: the ids it queries are rendered here.
//
// Events ride the handleEvent pattern with the element as the delegate —
// two listeners on the host cover all three buttons and the input
// (web-components-sampler's reno-* house style).

// Relative import: resolves both served (/ui/components/ → /ui/api.js) and
// under the tape6 test server (/static/ui/components/ → /static/ui/api.js).
import {setToken, showAuthDialog} from '../api.js';
import {makeHandlers} from './events.js';

const HANDLERS = makeHandlers('click', 'keydown');

class VaultSettings extends HTMLElement {
  connectedCallback() {
    if (this._ready) return;
    this._ready = true;

    const btn = document.createElement('button');
    btn.id = 'settings';
    btn.title = 'Settings';
    btn.textContent = '⚙';

    this._dlg = document.createElement('dialog');
    this._dlg.id = 'auth-dlg';
    this._dlg.innerHTML = `
      <h2>API token</h2>
      <p>
        Paste the bearer token (<code>VAULT_API_TOKEN</code>). Stored in your browser's
        localStorage.
      </p>
      <input id="auth-input" type="password" autocomplete="off" spellcheck="false" />
      <div class="dlg-row">
        <button id="auth-cancel">Cancel</button>
        <button id="auth-ok" class="primary">Save</button>
      </div>
    `;

    this.append(btn, this._dlg);
    Object.keys(HANDLERS).forEach(eventName => this.addEventListener(eventName, this));
  }

  handleEvent(e) {
    this[HANDLERS[e.type]](e);
  }

  onClick(e) {
    switch (e.target.closest('button')?.id) {
      case 'settings':
        showAuthDialog();
        break;
      case 'auth-cancel':
        this._dlg.close();
        break;
      case 'auth-ok':
        this._save();
        break;
    }
  }

  onKeydown(e) {
    if (e.key === 'Enter' && e.target.id === 'auth-input') this._save();
  }

  _save() {
    setToken(this._dlg.querySelector('#auth-input').value.trim());
    this._dlg.close();
    this.dispatchEvent(new CustomEvent('token-change', {bubbles: true}));
  }
}

customElements.define('vault-settings', VaultSettings);
