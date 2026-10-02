import test from 'tape-six';

import {
  diffUrl,
  encodePath,
  rangeText,
  renderRestorePrompt,
  renderVersionHead,
  renderVersions,
  renderViewSwitch,
  shortDate
} from '/static/ui/history-view.js';

const esc = s =>
  String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);

const doc = html => new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');

const items = [
  {
    sha: 'c'.repeat(40),
    date: '2026-09-30T23:35:07Z',
    author: 'uhop agents',
    subject: 'vault-storage auto-commit (1 file)',
    path: 'topics/b.md',
    change: 'renamed'
  },
  {
    sha: 'b'.repeat(40),
    date: '2026-09-29T08:01:00+00:00',
    subject: 'edit <b>',
    path: 'topics/a.md',
    change: 'modified'
  }
];

test('history view: dates, ranges, and paths', t => {
  t.equal(shortDate('2026-09-30T23:35:07Z'), '2026-09-30 23:35');
  t.equal(rangeText(0, 50), 'Versions 1–50');
  t.equal(rangeText(50, 3), 'Versions 51–53');
  t.equal(rangeText(0, 0), 'No committed versions.');
  t.equal(encodePath('topics/a b.md'), 'topics/a%20b.md', 'each segment encoded, slashes kept');
});

test('history view: one button per version, the old path shown after a rename', t => {
  const list = doc(renderVersions(items, 'topics/b.md', 'b'.repeat(40), esc));
  const buttons = [...list.querySelectorAll('button.version')];
  t.deepEqual(
    buttons.map(b => [b.dataset.sha[0], b.getAttribute('aria-pressed')]),
    [
      ['c', 'false'],
      ['b', 'true']
    ]
  );
  t.equal(buttons[0].querySelector('.path'), null, 'the current path is not repeated');
  t.equal(buttons[1].querySelector('.path').textContent, 'topics/a.md');
  t.equal(buttons[1].querySelector('.subject').textContent, 'edit <b>', 'text is escaped');
  t.equal(buttons[0].querySelector('.author').textContent, 'uhop agents', 'the writer (D136)');
  t.equal(buttons[1].querySelector('.author'), null, 'none from a server without authors');
});

test('history view: Restore on a version, never on a deletion', t => {
  const head = doc(renderVersionHead(items[1], esc));
  t.equal(head.querySelector('#restore').disabled, false);
  t.equal(head.querySelector('code').textContent, 'bbbbbbbb');
  t.matchString(
    doc(renderVersionHead(items[0], esc)).querySelector('div').textContent,
    /by uhop agents/
  );
  const gone = doc(renderVersionHead({...items[1], change: 'deleted'}, esc));
  t.equal(gone.querySelector('#restore').disabled, true);
  t.matchString(gone.querySelector('.why').textContent, /deleted the note/);
});

test('history view: the diff each view asks for (D138)', t => {
  const v = items[1];
  const url = view => new URL(diffUrl('topics/b.md', v, view), 'http://x').searchParams;
  const sides = view => Object.fromEntries([...url(view)].filter(([k]) => k !== 'path'));
  t.equal(url('changes').get('path'), 'topics/b.md');
  t.deepEqual(sides('changes'), {to: v.sha, to_path: 'topics/a.md', format: 'words'});
  t.deepEqual(sides('current'), {from: v.sha, from_path: 'topics/a.md', format: 'words'});
  t.deepEqual(
    sides('restore'),
    {from: 'current', to: v.sha, to_path: 'topics/a.md', format: 'words'},
    'a restore shows what it writes over the note'
  );
});

test('history view: the view switch, none pressed while a restore waits', t => {
  const pressed = view =>
    doc(renderViewSwitch(view)).querySelector('vault-switch').getAttribute('value');
  t.deepEqual(
    [...doc(renderViewSwitch('changes')).querySelectorAll('button')].map(b => b.dataset.value),
    ['content', 'changes', 'current']
  );
  t.equal(pressed('changes'), 'changes');
  t.equal(pressed('restore'), null);
  const prompt = doc(renderRestorePrompt(items[1], esc));
  t.ok(prompt.querySelector('#confirm-restore'));
  t.ok(prompt.querySelector('#cancel-restore'));
  t.matchString(prompt.querySelector('p').textContent, /2026-09-29 08:01/);
});
