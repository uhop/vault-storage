// <vault-settings> — the header's ⚙ settings button plus the shared API-token
// dialog (#auth-dlg), one implementation for every page: the hand-copied
// dialogs drifted (row-class rename, missing Enter-to-save on two pages, no
// button at all on agents.html). Light DOM per the house pattern; the dialog
// look lives in theme.css (`dlg-row` over `row` — archive-review's generic
// .row list class collides otherwise). Saving stores the token and dispatches
// a bubbling `token-change` — the page's refresh-after-auth hook. api.js's
// showAuthDialog() keeps working: the ids it queries are rendered here.

// Relative import: resolves both served (/ui/components/ → /ui/api.js) and
// under the tape6 test server (/static/ui/components/ → /static/ui/api.js).
import {setToken, showAuthDialog} from '../api.js';

class VaultSettings extends HTMLElement {
  connectedCallback() {
    if (this._ready) return;
    this._ready = true;

    const btn = document.createElement('button');
    btn.id = 'settings';
    btn.title = 'Settings';
    btn.textContent = '⚙';
    btn.addEventListener('click', showAuthDialog);

    const dlg = document.createElement('dialog');
    dlg.id = 'auth-dlg';
    dlg.innerHTML = `
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
    dlg.querySelector('#auth-cancel').addEventListener('click', () => dlg.close());
    dlg.querySelector('#auth-ok').addEventListener('click', () => {
      setToken(dlg.querySelector('#auth-input').value.trim());
      dlg.close();
      this.dispatchEvent(new CustomEvent('token-change', {bubbles: true}));
    });
    dlg.querySelector('#auth-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') dlg.querySelector('#auth-ok').click();
    });

    this.append(btn, dlg);
  }
}

customElements.define('vault-settings', VaultSettings);
