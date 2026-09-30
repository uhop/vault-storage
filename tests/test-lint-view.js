import test from 'tape-six';

import {
  DASHBOARD_FIXED,
  otherChecks,
  PAGE_SECTIONS,
  renderOtherChecks
} from '/static/ui/lint-view.js';

const esc = s =>
  String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);

const lint = {
  ok: false,
  checks: {
    orphan_embeddings: {count: 2, samples: []},
    dangling_tag_aliases: {count: 1, samples: [{id: 'a', canonical: 'b'}]},
    queue_hygiene: {count: 0, samples: []},
    import_failures: {
      count: 3,
      samples: [
        {file_path: 'topics/new.md', id: null, message: 'Map keys <must> be unique', seen_at: 't'},
        {file_path: 'topics/stale.md', id: 'rec-1', message: 'Map keys', seen_at: 't'}
      ]
    },
    auto_commit_failing: {count: 1, samples: []}
  }
};

test('otherChecks: the non-zero checks no action or section covers, in order', t => {
  t.deepEqual(
    otherChecks(lint).map(([name]) => name),
    ['import_failures', 'auto_commit_failing']
  );
  t.deepEqual(otherChecks({}), [], 'no checks, nothing');
  for (const name of PAGE_SECTIONS) t.notOk(DASHBOARD_FIXED.has(name), `${name} is in one set`);
});

test('renderOtherChecks: a card per check, samples as a table, paths linked when a record exists', t => {
  const html = renderOtherChecks(otherChecks(lint), esc);
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const cards = [...doc.querySelectorAll('section.fmw-card')];
  t.deepEqual(
    cards.map(c => c.dataset.section),
    ['import_failures', 'auto_commit_failing']
  );

  const [failures, commit] = cards;
  t.equal(failures.querySelector('.fmw-count').textContent, '3');
  t.deepEqual(
    [...failures.querySelectorAll('th')].map(th => th.textContent),
    ['file_path', 'id', 'message', 'seen_at']
  );
  const rows = [...failures.querySelectorAll('tbody tr')];
  t.equal(rows[0].querySelector('a'), null, 'a file with no record has no note link');
  t.equal(rows[0].cells[1].textContent, '—', 'a null id reads as a dash');
  t.equal(rows[0].cells[2].textContent, 'Map keys <must> be unique', 'text is escaped');
  t.equal(
    rows[1].querySelector('a').getAttribute('href'),
    '/ui/note.html?path=topics%2Fstale.md',
    'a stale record links to its note'
  );
  t.matchString(failures.querySelector('.why').textContent, /Showing 2 of 3/);

  t.equal(commit.querySelector('table'), null, 'a check without samples shows its count alone');
});
