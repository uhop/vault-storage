import test from 'tape-six';

import '/static/ui/components/vault-editor.js';

const NOTE = `---
title: Bug report
tags: ["bug"]
ready: true
---

First paragraph.

Second paragraph.
`;

const FRONTMATTER_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

const mount = () => {
  const el = document.createElement('vault-editor');
  el.style.whiteSpace = 'pre-wrap';
  document.body.appendChild(el);
  el.offsetHeight; // flush layout so the engine initializes the editing host
  return el;
};

const caretToStart = el => {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(true);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
};

// Reproduces what the component's own beforeinput handler does on Enter, so the
// break representation is the engine's rather than one this test assumes.
const typeLines = (el, text) => {
  caretToStart(el);
  text.split('\n').forEach((line, i) => {
    if (i > 0) document.execCommand('insertText', false, '\n');
    if (line) document.execCommand('insertText', false, line);
  });
};

// Building content from empty leaves Chromium and WebKit holding one extra
// trailing newline as the caret-able final line. It does not survive a real
// load-edit-save cycle (asserted below), so trailing breaks are not compared.
const trimEnd = s => s.replace(/\n+$/, '');

test('vault-editor preserves line breaks the engine built', async t => {
  await t.test('a typed note round-trips', t => {
    const el = mount();
    typeLines(el, NOTE);
    t.equal(trimEnd(el.value), trimEnd(NOTE), 'every break survives serialization');
    el.remove();
  });

  await t.test('a typed note still parses as frontmatter', t => {
    const el = mount();
    typeLines(el, NOTE);
    const match = FRONTMATTER_BLOCK.exec(el.value);
    t.ok(match, 'frontmatter block is recognizable after editing');
    t.ok(/ready:\s*true/.test(match?.[1] ?? ''), 'ready: true survives the round-trip');
    el.remove();
  });

  await t.test('blank lines between paragraphs survive', t => {
    const el = mount();
    typeLines(el, 'First paragraph.\n\nSecond paragraph.');
    t.equal(trimEnd(el.value), 'First paragraph.\n\nSecond paragraph.', 'paragraphs stay apart');
    t.notOk(/\.[A-Z]/.test(el.value), 'no sentences concatenated across the break');
    el.remove();
  });
});

test('vault-editor serializes known engine DOM shapes', async t => {
  const shapes = [
    {
      name: 'Chromium/WebKit <div>-per-line',
      html: '---<div>title: x</div><div>---</div><div><br></div><div>Body.</div>',
      value: '---\ntitle: x\n---\n\nBody.'
    },
    {
      name: 'Firefox literal newlines with trailing filler',
      html: '---\ntitle: x\n---\n\nBody.<br>',
      value: '---\ntitle: x\n---\n\nBody.'
    },
    {name: 'leading empty line', html: '<div><br></div><div>Body.</div>', value: '\nBody.'},
    {name: 'inline <br> inside a block', html: '<div>a<br>b</div>', value: 'a\nb'}
  ];
  for (const shape of shapes) {
    await t.test(shape.name, t => {
      const el = mount();
      el.innerHTML = shape.html;
      t.equal(el.value, shape.value, 'serializes to the expected text');
      el.remove();
    });
  }
});

test('vault-editor is stable across load-edit-save cycles', async t => {
  await t.test('editing does not accumulate trailing blank lines', t => {
    let content = 'Note body.\n';
    for (let i = 0; i < 3; i++) {
      const el = mount();
      el.value = content;
      el.focus();
      el.setSelectionRange(1, 1);
      document.execCommand('insertText', false, 'x');
      content = el.value;
      el.remove();
    }
    t.equal(content, 'Nxxxote body.\n', 'exactly one trailing newline after three cycles');
  });

  await t.test('the value setter round-trips losslessly', t => {
    const el = mount();
    el.value = NOTE;
    t.equal(el.value, NOTE, 'set then get is lossless');
    el.remove();
  });
});

test('vault-editor offsets agree with value across line breaks', async t => {
  await t.test('selectionStart matches every offset set', t => {
    const el = mount();
    el.value = NOTE;
    // Offsets around each break are where a text-node-only offset map drifts.
    const probes = [0, 3, 4, NOTE.indexOf('ready'), NOTE.indexOf('First'), NOTE.length];
    for (const offset of probes) {
      el.setSelectionRange(offset, offset);
      t.equal(el.selectionStart, offset, `offset ${offset} round-trips`);
    }
    el.remove();
  });

  await t.test('a range selects exactly the expected substring', t => {
    const el = mount();
    el.value = NOTE;
    const start = NOTE.indexOf('First paragraph.');
    const end = start + 'First paragraph.'.length;
    el.setSelectionRange(start, end);
    t.equal(el.selectionStart, start, 'start offset preserved');
    t.equal(el.selectionEnd, end, 'end offset preserved');
    el.remove();
  });
});
