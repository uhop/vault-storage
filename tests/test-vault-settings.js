import test from 'tape-six';

import '/static/ui/components/vault-settings.js';
import {getToken, setToken} from '/static/ui/api.js';

const mount = () => {
  const el = document.createElement('vault-settings');
  document.body.appendChild(el);
  return el;
};

test('vault-settings renders the button and the shared dialog', t => {
  const el = mount();
  try {
    const btn = el.querySelector('button#settings');
    t.ok(btn, 'settings button present');
    t.equal(btn.textContent, '⚙', 'gear glyph');
    t.ok(el.querySelector('dialog#auth-dlg'), 'auth dialog present');
    t.ok(el.querySelector('#auth-input'), 'token input present');
    t.ok(el.querySelector('#auth-ok'), 'save button present');
    t.ok(el.querySelector('#auth-cancel'), 'cancel button present');
    t.ok(el.querySelector('dialog .dlg-row'), 'button row uses the dlg-row class');

    el.remove();
    document.body.appendChild(el);
    t.equal(el.querySelectorAll('dialog').length, 1, 'reconnect is a no-op');
  } finally {
    el.remove();
  }
});

test('vault-settings save stores the token and fires token-change', t => {
  const el = mount();
  const saved = getToken();
  try {
    let events = 0;
    document.addEventListener('token-change', () => ++events, {once: true});

    el.querySelector('#auth-input').value = '  tok-123  ';
    el.querySelector('#auth-ok').click();
    t.equal(getToken(), 'tok-123', 'token stored trimmed');
    t.equal(events, 1, 'token-change bubbled to document');
    t.notOk(el.querySelector('dialog').open, 'dialog closed after save');
  } finally {
    setToken(saved);
    el.remove();
  }
});

test('vault-settings cancel closes without saving or firing', t => {
  const el = mount();
  const saved = getToken();
  try {
    setToken('before');
    let events = 0;
    const count = () => ++events;
    document.addEventListener('token-change', count);

    el.querySelector('#auth-input').value = 'discarded';
    el.querySelector('#auth-cancel').click();
    document.removeEventListener('token-change', count);
    t.equal(getToken(), 'before', 'token untouched');
    t.equal(events, 0, 'no token-change on cancel');
  } finally {
    setToken(saved);
    el.remove();
  }
});

test('vault-settings Enter in the input saves', t => {
  const el = mount();
  const saved = getToken();
  try {
    const input = el.querySelector('#auth-input');
    input.value = 'tok-enter';
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    t.equal(getToken(), 'tok-enter', 'Enter triggers save');
  } finally {
    setToken(saved);
    el.remove();
  }
});

test('vault-settings button opens the dialog prefilled', t => {
  const el = mount();
  const saved = getToken();
  try {
    setToken('stored-token');
    el.querySelector('#settings').click();
    const dlg = el.querySelector('dialog');
    t.ok(dlg.open, 'dialog opened');
    t.equal(el.querySelector('#auth-input').value, 'stored-token', 'prefilled from storage');
    dlg.close();
  } finally {
    setToken(saved);
    el.remove();
  }
});
