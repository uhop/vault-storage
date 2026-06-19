// <vault-editor> — a plain-text editor surface (light-DOM contenteditable) that
// presents a <textarea>-compatible API (value, selectionStart/selectionEnd,
// setSelectionRange, focus, disabled, the `input` event) plus range highlighting
// via the CSS Custom Highlight API.
//
// Light DOM (no shadow root) on purpose: Selection/Range, ::highlight(), and the
// host page's CSS (theme vars, layout, the data-view show/hide rules) all work
// without a shadow boundary — and cross-boundary selection is a known pain.
//
// Content is kept a flat run of text + '\n' (Enter and paste are normalized to
// plain text), so a character offset maps straight to a DOM Range.

const HL_ALL = 'vault-find';
const HL_CUR = 'vault-find-current';
const supportsHighlight = typeof Highlight !== 'undefined' && !!(window.CSS && CSS.highlights);

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

    // execCommand('insertText') is deprecated but is the one call that still
    // inserts text while preserving the native undo stack (direct DOM mutation
    // loses it). Used to keep Enter/paste as plain '\n' text, no <br>/<div>.
    this.addEventListener('beforeinput', e => {
      if (e.inputType === 'insertParagraph' || e.inputType === 'insertLineBreak') {
        e.preventDefault();
        document.execCommand('insertText', false, '\n');
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
    let s = '';
    const w = document.createTreeWalker(this, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) s += n.data;
    return s;
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

  _sel() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !this.contains(sel.anchorNode)) return {start: 0, end: 0};
    const r = sel.getRangeAt(0);
    const a = this._offsetOf(r.startContainer, r.startOffset);
    const b = this._offsetOf(r.endContainer, r.endOffset);
    return {start: Math.min(a, b), end: Math.max(a, b)};
  }

  _point(offset) {
    const w = document.createTreeWalker(this, NodeFilter.SHOW_TEXT);
    let acc = 0;
    let last = null;
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      last = n;
      if (acc + n.data.length >= offset) return {node: n, offset: offset - acc};
      acc += n.data.length;
    }
    return last ? {node: last, offset: last.data.length} : {node: this, offset: 0};
  }

  _offsetOf(node, nodeOffset) {
    if (node === this) {
      let acc = 0;
      for (let i = 0; i < nodeOffset && i < this.childNodes.length; i++) {
        acc += (this.childNodes[i].textContent || '').length;
      }
      return acc;
    }
    let acc = 0;
    const w = document.createTreeWalker(this, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n === node) return acc + nodeOffset;
      acc += n.data.length;
    }
    return acc;
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
