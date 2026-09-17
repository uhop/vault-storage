import test from 'tape-six';

import '/static/ui/components/vault-switch.js';

const BUTTONS =
  '<button data-value="a">A</button><button data-value="b">B</button><button data-value="c">C</button>';

const mount = (attrs = '', html = BUTTONS) => {
  const host = document.createElement('div');
  host.innerHTML = `<vault-switch ${attrs}>${html}</vault-switch>`;
  document.body.appendChild(host);
  return [host.firstElementChild, host];
};
const pressed = el => [...el.querySelectorAll('[aria-pressed="true"]')].map(b => b.dataset.value);

test('vault-switch takes authored buttons, presses the value, and sets the group role', t => {
  const [el, host] = mount('value="b"');
  try {
    t.equal(el.getAttribute('role'), 'group');
    t.deepEqual(
      [...el.querySelectorAll('button')].map(b => b.type),
      ['button', 'button', 'button'],
      'buttons never submit'
    );
    t.deepEqual(pressed(el), ['b'], 'the authored value is pressed');
    t.equal(el.querySelector('[data-value="a"]').getAttribute('aria-pressed'), 'false');

    el.value = 'c';
    t.deepEqual(pressed(el), ['c'], 'the setter moves the pressed state');
    t.equal(el.getAttribute('value'), 'c', 'and reflects to the attribute');

    el.value = null;
    t.deepEqual(pressed(el), [], 'null presses nothing');
    t.equal(el.value, null);
  } finally {
    host.remove();
  }
});

test('vault-switch dispatches change on a click, never on the setter or a repeat', t => {
  const [el, host] = mount('value="a"');
  const seen = [];
  el.addEventListener('change', e => seen.push(e.detail.value));
  try {
    el.querySelector('[data-value="b"]').click();
    t.deepEqual(seen, ['b'], 'a click dispatches the value');
    t.deepEqual(pressed(el), ['b'], 'and presses it');

    el.querySelector('[data-value="b"]').click();
    t.deepEqual(seen, ['b'], 'clicking the pressed button is a no-op');

    el.value = 'c';
    t.deepEqual(seen, ['b'], 'the setter is silent');
  } finally {
    host.remove();
  }
});

test('vault-switch moves on the arrow keys, wrapping around', t => {
  const [el, host] = mount('value="a"');
  const seen = [];
  el.addEventListener('change', e => seen.push(e.detail.value));
  const key = (from, k) =>
    el
      .querySelector(`[data-value="${from}"]`)
      .dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true}));
  try {
    key('a', 'ArrowRight');
    t.deepEqual(pressed(el), ['b']);
    key('b', 'ArrowDown');
    t.deepEqual(pressed(el), ['c']);
    key('c', 'ArrowRight');
    t.deepEqual(pressed(el), ['a'], 'wraps forward');
    key('a', 'ArrowLeft');
    t.deepEqual(pressed(el), ['c'], 'wraps backward');
    t.deepEqual(seen, ['b', 'c', 'a', 'c'], 'each move dispatches');
    t.equal(document.activeElement, el.querySelector('[data-value="c"]'), 'focus follows');
  } finally {
    host.remove();
  }
});

test('vault-switch with param writes the query on change and clears it on the default', t => {
  // The test page runs at about:srcdoc, where the history API refuses a URL, so the
  // write is captured instead of applied.
  const written = [];
  const replaceState = history.replaceState;
  history.replaceState = (state, title, url) => written.push(new URL(url).searchParams.get('view'));
  const [el, host] = mount('param="view" default="a"');
  try {
    t.equal(el.value, 'a', 'no query: the default is pressed');
    el.querySelector('[data-value="c"]').click();
    t.deepEqual(written, ['c'], 'a change writes the parameter');
    el.querySelector('[data-value="a"]').click();
    t.deepEqual(written, ['c', null], 'the default clears it');
    t.deepEqual(pressed(el), ['a']);
    el.value = 'b';
    t.deepEqual(written, ['c', null], 'the setter writes nothing');
  } finally {
    host.remove();
    history.replaceState = replaceState;
  }
});

test('vault-switch with param yields the query read to a value set first', t => {
  const [el, host] = mount('param="view" default="a" value="c"');
  try {
    t.equal(el.value, 'c', 'an authored value wins over the query and the default');
  } finally {
    host.remove();
  }
  const early = document.createElement('vault-switch');
  early.setAttribute('param', 'view');
  early.setAttribute('default', 'a');
  early.innerHTML = BUTTONS;
  Object.defineProperty(early, 'value', {value: 'b', writable: true, configurable: true});
  document.body.appendChild(early);
  try {
    t.equal(early.value, 'b', 'a value set before the upgrade wins over the query read');
    t.deepEqual(pressed(early), ['b']);
  } finally {
    early.remove();
  }
});

test('vault-switch with param and no query takes the default', t => {
  const restore = location.href;
  const url = new URL(location.href);
  url.searchParams.delete('view');
  history.replaceState(null, '', url);
  const [el, host] = mount('param="view" default="b"');
  try {
    t.equal(el.value, 'b');
  } finally {
    host.remove();
    history.replaceState(null, '', restore);
  }
});

test('vault-switch takes a value set before the upgrade and keeps the accessor', t => {
  const el = document.createElement('vault-switch');
  el.innerHTML = BUTTONS;
  Object.defineProperty(el, 'value', {value: 'b', writable: true, configurable: true});
  const errors = [];
  const onError = e => errors.push(e.message);
  window.addEventListener('error', onError);
  document.body.appendChild(el);
  window.removeEventListener('error', onError);
  try {
    t.deepEqual(errors, [], 'the upgrade reports no error');
    t.deepEqual(pressed(el), ['b'], 'the early value is pressed');
    el.value = 'c';
    t.deepEqual(pressed(el), ['c'], 'later assignments reach the accessor');
  } finally {
    el.remove();
  }
});
