// <vault-toolbar> — the editor page's status strip (design/light-ui.md phase 4:
// title + save state + view toggle) as a light-DOM component. The standard
// parts — path label, status pill, view-mode group — are built and prepended
// on connect; authored children (page-specific action buttons) stay in place
// after them, so a page declares its own actions as plain markup.
//
// Light DOM on purpose, same rationale as <vault-editor>: the host page's CSS
// (`.toolbar`, `.pill`, `.modes`) styles the parts without a shadow boundary.
//
// Mode contract: the view-mode group is a <vault-switch>; its change becomes a
// bubbling `mode-change` {detail: {mode}}; persistence policy (URL param /
// localStorage / viewport default, body dataset) stays with the page, which
// reflects back through the `mode` setter — both writes are idempotent.

import './vault-switch.js';

const MODES = [
  {mode: 'edit', label: 'edit', title: 'Edit only'},
  {mode: 'split', label: 'split', title: 'Editor + preview side-by-side'},
  {mode: 'preview', label: 'preview', title: 'Rendered preview only'}
];

class VaultToolbar extends HTMLElement {
  connectedCallback() {
    if (this._ready) return;
    this._ready = true;

    this._path = document.createElement('span');
    this._path.className = 'path';

    this._pill = document.createElement('span');
    this._pill.className = 'pill';
    this._pill.textContent = 'idle';

    this._modes = document.createElement('vault-switch');
    this._modes.className = 'modes';
    this._modes.setAttribute('aria-label', 'View mode');
    for (const {mode, label, title} of MODES) {
      const btn = document.createElement('button');
      btn.dataset.value = mode;
      btn.title = title;
      btn.textContent = label;
      this._modes.appendChild(btn);
    }
    this._modes.addEventListener('change', this);

    this.prepend(this._path, this._pill, this._modes);
  }

  handleEvent(e) {
    e.stopPropagation();
    this.dispatchEvent(
      new CustomEvent('mode-change', {detail: {mode: e.detail.value}, bubbles: true})
    );
  }

  get path() {
    return this._path?.textContent ?? '';
  }

  set path(text) {
    if (this._path) this._path.textContent = text;
  }

  /** Currently pressed view mode, or null before the page sets one. */
  get mode() {
    return this._modes?.value ?? null;
  }

  set mode(mode) {
    if (this._modes) this._modes.value = mode;
  }

  /** Save-state pill: kind ∈ idle|editing|saving|saved|offline; `saving` puts a spinner before its label, "saving…" when the label is empty. */
  setStatus(kind, label) {
    if (!this._pill) return;
    this._pill.className = 'pill ' + kind;
    this._pill.textContent = '';
    if (kind === 'saving') {
      const spin = document.createElement('span');
      spin.className = 'spinner';
      this._pill.append(spin, ' ' + (label || 'saving…'));
    } else {
      this._pill.textContent = label;
    }
  }
}

customElements.define('vault-toolbar', VaultToolbar);
