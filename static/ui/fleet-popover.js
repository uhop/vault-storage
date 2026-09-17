// Chips with a details popover: hover or keyboard focus shows it, a click (a
// tap on touch) pins it so its links can be reached, Escape or a click outside
// closes it. The details ride in `data-pop` as JSON and render as text nodes.

import {esc} from './api.js';

const STYLE = `
.chip { font: inherit; font-family: var(--mono); font-size: 0.8rem; line-height: 1.3; padding: 0 0.35em; margin: 0.1rem 0.15rem 0.1rem 0; border: 1px solid var(--line); border-radius: 4px; background: var(--card); color: var(--fg); cursor: pointer; position: relative; vertical-align: baseline; }
.chip:hover, .chip[aria-expanded='true'] { border-color: var(--accent); }
.chip.bot { color: light-dark(#6f42c1, #b392f0); border-color: light-dark(#c9b3ee, #5e4b8b); }
.chip.draft { border-style: dashed; }
.chip.new { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 16%, var(--card)); font-weight: 600; }
.chip.warn { color: var(--warn); border-color: var(--warn); }
.chip.bad { color: var(--bad); border-color: var(--bad); }
.chip.active::after { content: ''; position: absolute; top: -3px; right: -3px; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--bg); }
.pop { position: absolute; z-index: 60; max-width: min(26rem, calc(100vw - 16px)); background: var(--card); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18); padding: 0.5rem 0.7rem; font-size: 0.85rem; line-height: 1.4; }
.pop .t { font-weight: 600; margin-bottom: 0.2rem; overflow-wrap: anywhere; }
.pop .l { color: var(--muted); overflow-wrap: anywhere; }
.pop .q { margin: 0.3rem 0; padding-left: 0.5rem; border-left: 2px solid var(--line); overflow-wrap: anywhere; }
.pop .a { margin-top: 0.35rem; display: flex; flex-wrap: wrap; gap: 0.2rem 0.8rem; }
.pop .a a { color: var(--accent); }
`;

let styled = false;
const ensureStyle = () => {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = STYLE;
  document.head.append(el);
};

// {title, lines: [string], quote, links: [{text, href}]}; classes from the
// fixed chip vocabulary above.
export const chip = (text, pop, classes = []) =>
  `<button type="button" class="${['chip', ...classes].join(' ')}" aria-expanded="false" data-pop="${esc(JSON.stringify(pop))}">${esc(text)}</button>`;

const safeHref = href =>
  typeof href === 'string' && (href.startsWith('https://') || href.startsWith('/ui/'))
    ? href
    : null;

const render = (pop, spec) => {
  const add = (cls, text) => {
    const div = document.createElement('div');
    div.className = cls;
    div.textContent = text;
    pop.append(div);
  };
  pop.replaceChildren();
  if (spec.title) add('t', spec.title);
  for (const line of spec.lines ?? []) add('l', line);
  if (spec.quote) add('q', spec.quote);
  const links = (spec.links ?? []).filter(l => safeHref(l.href));
  if (links.length) {
    const div = document.createElement('div');
    div.className = 'a';
    for (const l of links) {
      const a = document.createElement('a'),
        href = safeHref(l.href);
      a.href = href;
      a.textContent = l.text;
      if (href.startsWith('https://')) {
        a.target = '_blank';
        a.rel = 'noopener';
      }
      div.append(a);
    }
    pop.append(div);
  }
};

export const bindPopovers = root => {
  ensureStyle();
  const pop = document.createElement('div');
  pop.className = 'pop';
  pop.hidden = true;
  pop.setAttribute('role', 'dialog');
  document.body.append(pop);
  let anchor = null,
    pinned = false,
    timer = null;

  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth,
      h = pop.offsetHeight;
    const left = Math.max(8, Math.min(r.left, document.documentElement.clientWidth - w - 8));
    const below = r.bottom + 6 + h <= window.innerHeight;
    pop.style.left = `${left + window.scrollX}px`;
    pop.style.top = `${(below ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + window.scrollY}px`;
  };
  const show = (el, pin) => {
    clearTimeout(timer);
    let spec;
    try {
      spec = JSON.parse(el.dataset.pop);
    } catch {
      return;
    }
    if (anchor && anchor !== el) anchor.setAttribute('aria-expanded', 'false');
    anchor = el;
    pinned = pin;
    render(pop, spec);
    pop.hidden = false;
    el.setAttribute('aria-expanded', 'true');
    place();
  };
  const hide = () => {
    clearTimeout(timer);
    anchor?.setAttribute('aria-expanded', 'false');
    anchor = null;
    pinned = false;
    pop.hidden = true;
  };
  const hideSoon = () => {
    if (pinned) return;
    clearTimeout(timer);
    timer = setTimeout(hide, 200);
  };
  const chipOf = e => e.target.closest?.('.chip[data-pop]');

  root.addEventListener('pointerover', e => {
    const el = chipOf(e);
    if (el && e.pointerType === 'mouse' && !pinned) show(el, false);
  });
  root.addEventListener('pointerout', e => {
    if (chipOf(e) && e.pointerType === 'mouse') hideSoon();
  });
  root.addEventListener('click', e => {
    const el = chipOf(e);
    if (!el) return;
    if (pinned && anchor === el) hide();
    else show(el, true);
  });
  root.addEventListener('focusin', e => {
    const el = chipOf(e);
    if (el && !pinned) show(el, false);
  });
  root.addEventListener('focusout', e => {
    if (chipOf(e) && !pop.contains(e.relatedTarget)) hideSoon();
  });
  pop.addEventListener('pointerenter', () => clearTimeout(timer));
  pop.addEventListener('pointerleave', hideSoon);
  document.addEventListener('click', e => {
    if (!pop.hidden && !pop.contains(e.target) && !chipOf(e)) hide();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !pop.hidden) {
      const el = anchor;
      hide();
      el?.focus();
    }
  });
  window.addEventListener('resize', hide);
  return {hide};
};
