import test from 'tape-six';

import '/static/ui/components/vault-toolbar.js';

const mount = html => {
  const el = document.createElement('vault-toolbar');
  if (html) el.innerHTML = html;
  document.body.appendChild(el);
  return el;
};

test('vault-toolbar builds its standard parts and keeps authored children', t => {
  const el = mount('<button id="my-action">Act</button>');
  try {
    t.ok(el.querySelector('.path'), 'path label present');
    t.ok(el.querySelector('.pill'), 'status pill present');
    t.equal(el.querySelectorAll('.modes button').length, 3, 'three mode buttons');
    const last = el.children[el.children.length - 1];
    t.equal(last.id, 'my-action', 'authored action button survives, after the standard parts');
    t.equal(el.children[0].className, 'path', 'standard parts are prepended');
  } finally {
    el.remove();
  }
});

test('vault-toolbar path and status API', t => {
  const el = mount();
  try {
    t.equal(el.path, '', 'path starts empty');
    el.path = 'topics/alpha.md';
    t.equal(el.querySelector('.path').textContent, 'topics/alpha.md', 'path rendered');
    t.equal(el.path, 'topics/alpha.md', 'path readable back');

    el.setStatus('saved', 'saved 12:00');
    t.equal(el.querySelector('.pill').className, 'pill saved', 'status kind becomes a class');
    t.equal(el.querySelector('.pill').textContent, 'saved 12:00', 'label rendered as text');

    el.setStatus('editing', '<b>not html</b>');
    t.equal(
      el.querySelector('.pill').innerHTML,
      '&lt;b&gt;not html&lt;/b&gt;',
      'labels are text, never markup'
    );

    el.setStatus('saving', 'ignored');
    t.ok(el.querySelector('.pill .spinner'), 'saving renders its spinner');
    t.matchString(el.querySelector('.pill').textContent, /saving…/, 'saving renders its own label');
  } finally {
    el.remove();
  }
});

test('vault-toolbar mode toggle: pressed state and mode-change event', t => {
  const el = mount();
  try {
    t.equal(el.mode, null, 'no mode pressed initially');

    el.mode = 'split';
    t.equal(el.mode, 'split', 'setter reflected by getter');
    t.equal(
      el.querySelector('[data-mode="split"]').getAttribute('aria-pressed'),
      'true',
      'target pressed'
    );
    t.equal(
      el.querySelector('[data-mode="edit"]').getAttribute('aria-pressed'),
      'false',
      'others released'
    );

    let got = null;
    el.addEventListener('mode-change', e => (got = e.detail.mode));
    el.querySelector('[data-mode="preview"]').click();
    t.equal(got, 'preview', 'click dispatches mode-change with the mode');
    t.equal(el.mode, 'preview', 'pressed state follows the click');
  } finally {
    el.remove();
  }
});
