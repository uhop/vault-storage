// <vault-editor> — a plain-text editor surface (light-DOM contenteditable) that
// presents a <textarea>-compatible API (value, selectionStart/selectionEnd,
// setSelectionRange, focus, disabled, the `input` event) plus range highlighting
// via the CSS Custom Highlight API.
//
// Light DOM (no shadow root) on purpose: Selection/Range, ::highlight(), and the
// host page's CSS (theme vars, layout, the data-view show/hide rules) all work
// without a shadow boundary — and cross-boundary selection is a known pain.
//
// Enter and paste are normalized to plain text, but engines still represent a
// line break differently in the DOM (Firefox a '\n' text node, Chromium/WebKit
// a <div> boundary), so `_segments()` — not a raw text walk — is the one place
// that turns the DOM into text + offsets.

const HL_ALL = 'vault-find';
const HL_CUR = 'vault-find-current';
const supportsHighlight = typeof Highlight !== 'undefined' && !!(window.CSS && CSS.highlights);

const BLOCK_TAGS = new Set([
  'DIV',
  'P',
  'LI',
  'UL',
  'OL',
  'PRE',
  'BLOCKQUOTE',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6'
]);

const indexOf = (parent, child) => Array.prototype.indexOf.call(parent.childNodes, child);

class VaultEditor extends HTMLElement {
  connectedCallback() {
    if (this._ready) return;
    this._ready = true;

    // Prefer plaintext-only (kills rich formatting/paste); the beforeinput/paste
    // handlers below keep it plain even on the 'true' fallback for old engines.
    this.setAttribute('contenteditable', 'plaintext-only');
    if (this.contentEditable !== 'plaintext-only') this.setAttribute('contenteditable', 'true');
    this._mode = this.getAttribute('contenteditable');

    if (!this.hasAttribute('role')) this.setAttribute('role', 'textbox');
    this.setAttribute('aria-multiline', 'true');
    if (!this.hasAttribute('spellcheck')) this.setAttribute('spellcheck', 'true');

    // execCommand('insertText') is deprecated but is the one call that inserts
    // text while preserving the native undo stack (direct DOM mutation loses it).
    // WebKit re-dispatches beforeinput as insertLineBreak for the '\n' inserted
    // here and performs the actual insertion as that nested event's default
    // action, so the re-entrant pass must fall through untouched — guarding it
    // (return before insert) drops the break; preventing its default drops it too.
    this.addEventListener('beforeinput', e => {
      if (e.inputType !== 'insertParagraph' && e.inputType !== 'insertLineBreak') return;
      if (this._inserting) return;
      e.preventDefault();
      this._inserting = true;
      try {
        document.execCommand('insertText', false, '\n');
      } finally {
        this._inserting = false;
      }
    });
    this.addEventListener('paste', e => {
      e.preventDefault();
      const t = e.clipboardData.getData('text/plain');
      document.execCommand('insertText', false, t.replace(/\r\n?/g, '\n'));
    });
    this.addEventListener('input', () => this._reflectEmpty());
    this._reflectEmpty();
  }

  // --- textarea-compatible API -------------------------------------------
  get value() {
    return this._segments()
      .map(s => s.text)
      .join('');
  }

  set value(v) {
    this.textContent = v;
    this._reflectEmpty();
  }

  get selectionStart() {
    return this._sel().start;
  }

  get selectionEnd() {
    return this._sel().end;
  }

  setSelectionRange(start, end) {
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(this._range(start, end));
  }

  get disabled() {
    return this.getAttribute('contenteditable') === 'false';
  }

  set disabled(on) {
    this.setAttribute('contenteditable', on ? 'false' : this._mode);
    this.classList.toggle('loading', !!on);
  }

  // --- highlighting + scroll ---------------------------------------------
  // `starts` is an array of match start offsets, all of length `len`; the match
  // at `currentIdx` is highlighted distinctly. No DOM mutation — ranges only.
  setHighlights(starts, currentIdx, len) {
    if (!supportsHighlight) {
      if (currentIdx >= 0 && starts[currentIdx] != null) {
        this.setSelectionRange(starts[currentIdx], starts[currentIdx] + len);
      }
      return;
    }
    let all = CSS.highlights.get(HL_ALL);
    let cur = CSS.highlights.get(HL_CUR);
    if (!all) {
      all = new Highlight();
      CSS.highlights.set(HL_ALL, all);
    }
    if (!cur) {
      cur = new Highlight();
      cur.priority = 1;
      CSS.highlights.set(HL_CUR, cur);
    }
    all.clear();
    cur.clear();
    if (!len) return;
    starts.forEach((s, i) => (i === currentIdx ? cur : all).add(this._range(s, s + len)));
  }

  clearHighlights() {
    if (!supportsHighlight) return;
    CSS.highlights.get(HL_ALL)?.clear();
    CSS.highlights.get(HL_CUR)?.clear();
  }

  scrollToOffset(start, end = start) {
    const rect = this._range(start, end).getBoundingClientRect();
    const box = this.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) return;
    if (rect.top < box.top || rect.bottom > box.bottom) {
      this.scrollTop += rect.top - box.top - this.clientHeight / 3;
    }
  }

  // --- internals ---------------------------------------------------------
  _reflectEmpty() {
    this.classList.toggle('empty', this.value.length === 0);
  }

  // Engines disagree on what Enter leaves in the DOM: Firefox inserts a literal
  // '\n' text character, Chromium and WebKit wrap each line in a <div> (an empty
  // line being <div><br></div>) even under contenteditable=plaintext-only. A
  // text-node-only walk therefore drops every line break on 2 of the 3 engines —
  // which silently merged paragraphs and un-parsed frontmatter on save. One walk
  // produces the text and the offset map together so `value` and the
  // selection/highlight offsets can never disagree about where a break sits.
  _segments() {
    const segments = [];
    let length = 0;
    let started = false;
    const push = (text, node, anchor) => {
      segments.push({text, node, anchor, base: length});
      length += text.length;
    };
    const walk = el => {
      for (const n of el.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) {
          push(n.data, n, null);
          started = true;
        } else if (n.nodeName === 'BR') {
          // A <br> closing its parent is the filler that makes an empty block
          // visible, not a break of its own — counting it would double-space.
          if (n.nextSibling) push('\n', null, {node: el, offset: indexOf(el, n) + 1});
          started = true;
        } else if (BLOCK_TAGS.has(n.nodeName)) {
          if (started) push('\n', null, {node: n, offset: 0});
          started = true;
          walk(n);
        } else {
          walk(n);
        }
      }
    };
    walk(this);
    return segments;
  }

  _sel() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !this.contains(sel.anchorNode)) return {start: 0, end: 0};
    const r = sel.getRangeAt(0);
    const a = this._offsetOf(r.startContainer, r.startOffset);
    const b = this._offsetOf(r.endContainer, r.endOffset);
    return {start: Math.min(a, b), end: Math.max(a, b)};
  }

  _point(offset) {
    let last = null;
    for (const s of this._segments()) {
      if (!s.node) {
        if (offset < s.base + s.text.length) return s.anchor;
        continue;
      }
      if (offset <= s.base + s.text.length) {
        return {node: s.node, offset: Math.max(0, offset - s.base)};
      }
      last = s;
    }
    return last ? {node: last.node, offset: last.node.data.length} : {node: this, offset: 0};
  }

  _offsetOf(node, nodeOffset) {
    const segments = this._segments();
    if (node === this) {
      const child = this.childNodes[nodeOffset];
      if (!child) return segments.reduce((n, s) => n + s.text.length, 0);
      for (const s of segments) {
        const owner = s.node ?? s.anchor.node;
        if (owner === child || child.contains(owner)) return s.base;
      }
      return segments.reduce((n, s) => n + s.text.length, 0);
    }
    for (const s of segments) {
      if (s.node === node) return s.base + nodeOffset;
    }
    return segments.reduce((n, s) => n + s.text.length, 0);
  }

  _range(start, end) {
    const a = this._point(start);
    const b = this._point(end);
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(b.node, b.offset);
    return r;
  }
}

customElements.define('vault-editor', VaultEditor);
