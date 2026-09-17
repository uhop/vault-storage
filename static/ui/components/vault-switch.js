// <vault-switch> — the segmented control: one pressed button among its authored
// <button data-value> children. A click or an arrow key moves the pressed state
// and dispatches a bubbling `change` {detail: {value}}; setting `value` moves it
// silently, so a page reflects its own state without an echo. With a `param`
// attribute the value also lives in the location's query, read on connect when
// nothing set a value first and written on change, and the `default` value is
// written as no parameter, so a view stays linkable. Light DOM, the look in theme.css; a page restates the
// size or the pressed look (design/ui-css-component-system).

import {makeHandlers} from './events.js';

const HANDLERS = makeHandlers('click', 'keydown');
const STEP = {ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1};

class VaultSwitch extends HTMLElement {
  static observedAttributes = ['value'];

  connectedCallback() {
    if (!this._ready) {
      if (!this.hasAttribute('role')) this.setAttribute('role', 'group');
      for (const b of this.buttons) b.type = 'button';
      // A `value` set before the element upgraded is an own property shadowing the accessor.
      if (Object.hasOwn(this, 'value')) {
        const v = this.value;
        delete this.value;
        this.value = v;
      }
      // The query names the value only when nothing set one first: an authored
      // attribute, or a page that validated and set it before the upgrade.
      const param = this.getAttribute('param');
      if (param && this.value === null)
        this.value =
          new URLSearchParams(location.search).get(param) ?? this.getAttribute('default');
      this._ready = true;
      this.press();
    }
    this.addEventListener('click', this);
    this.addEventListener('keydown', this);
  }

  disconnectedCallback() {
    this.removeEventListener('click', this);
    this.removeEventListener('keydown', this);
  }

  attributeChangedCallback() {
    if (this._ready) this.press();
  }

  handleEvent(e) {
    this[HANDLERS[e.type]](e);
  }

  get buttons() {
    return [...this.querySelectorAll(':scope > button[data-value]')];
  }

  get value() {
    return this.getAttribute('value');
  }

  set value(v) {
    if (v === null || v === undefined) this.removeAttribute('value');
    else this.setAttribute('value', v);
  }

  press() {
    const v = this.value;
    for (const b of this.buttons) b.setAttribute('aria-pressed', String(b.dataset.value === v));
  }

  select(value) {
    if (value === this.value) return;
    this.value = value;
    const param = this.getAttribute('param');
    if (param) {
      const url = new URL(location.href);
      if (value === this.getAttribute('default')) url.searchParams.delete(param);
      else url.searchParams.set(param, value);
      history.replaceState(null, '', url);
    }
    this.dispatchEvent(new CustomEvent('change', {detail: {value}, bubbles: true}));
  }

  onClick(e) {
    const b = e.target.closest('button[data-value]');
    if (b && b.parentElement === this) this.select(b.dataset.value);
  }

  onKeydown(e) {
    const step = STEP[e.key];
    if (!step) return;
    const buttons = this.buttons;
    const i = buttons.indexOf(e.target);
    if (i < 0) return;
    e.preventDefault();
    const next = buttons[(i + step + buttons.length) % buttons.length];
    next.focus();
    this.select(next.dataset.value);
  }
}

customElements.define('vault-switch', VaultSwitch);
