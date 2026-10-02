import test from 'tape-six';

import {day, orderKeys, renderKeys, renderSecret, renderWhoAmI} from '/static/ui/keys-view.js';

const esc = s =>
  String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);

const doc = html => new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');

const keys = [
  {
    id: 'k1',
    name: 'old bot',
    kind: 'agent',
    email: null,
    created: '2026-09-01T00:00:00Z',
    expires_at: null,
    recalled_at: '2026-09-20T10:00:00Z',
    status: 'recalled'
  },
  {
    id: 'k2',
    name: 'uhop <agents>',
    kind: 'agent',
    email: 'a@example.com',
    created: '2026-10-02T01:00:00Z',
    expires_at: '2027-01-01T00:00:00Z',
    recalled_at: null,
    status: 'active'
  },
  {
    id: 'k3',
    name: 'laptop',
    kind: 'person',
    email: null,
    created: '2026-10-01T00:00:00Z',
    expires_at: null,
    recalled_at: null,
    status: 'active'
  }
];

test('keys view: the active keys first, newest first, recall only on an active key', t => {
  t.deepEqual(
    orderKeys(keys).map(k => k.id),
    ['k2', 'k3', 'k1']
  );
  const table = doc(renderKeys(keys, esc));
  const rows = [...table.querySelectorAll('tbody tr')];
  t.deepEqual(
    rows.map(r => r.dataset.id),
    ['k2', 'k3', 'k1']
  );
  t.equal(rows[0].cells[0].textContent, 'uhop <agents>', 'a name is escaped');
  t.equal(rows[0].querySelector('button.recall').dataset.name, 'uhop <agents>');
  t.equal(rows[2].querySelector('button.recall'), null, 'no recall on a recalled key');
  t.matchString(rows[2].cells[3].textContent, /recalled 2026-09-20/);
  t.equal(rows[0].cells[5].textContent, '2027-01-01');
  t.equal(rows[1].cells[5].textContent, '—', 'no expiry');
  t.equal(day(null), '—');
  t.matchString(doc(renderKeys([], esc)).body.textContent, /No named keys yet/);
});

test('keys view: who the page is, and a new secret shown once', t => {
  t.matchString(
    doc(renderWhoAmI({name: 'operator', kind: 'person'}, esc)).body.textContent,
    /operator \(person\)/
  );
  const box = doc(renderSecret({key: keys[1], secret: 'vsk_abc<d>'}, esc));
  t.equal(box.querySelector('#secret-text').textContent, 'vsk_abc<d>', 'the secret, escaped');
  t.ok(box.querySelector('#copy-secret'), 'with a copy button');
});
