// Manual auto / light / dark override for the UI theme.
//
// Companion to /ui/theme.css and the per-page pre-hydration <script> in
// each <head> (which writes data-theme on <html> from localStorage before
// first paint to avoid FOUC). This module renders the [Auto][Light][Dark]
// segmented control into a <div id="theme-toggle"> placeholder, wires
// click handlers, and reflects the active state on the wrapper.
//
// CSS does the actual color flipping via light-dark() against
// color-scheme, which the data-theme attribute controls.

const KEY = 'vault.theme';

const ICONS = {
  // Half-disc: auto (browser/OS decides).
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2 a10 10 0 0 1 0 20 Z" fill="currentColor"/></svg>',
  // Sun: light.
  light:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>',
  // Crescent: dark.
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>'
};

const get = () => {
  const t = localStorage.getItem(KEY);
  return t === 'light' || t === 'dark' ? t : 'auto';
};

const apply = mode => {
  if (mode === 'auto') {
    localStorage.removeItem(KEY);
    delete document.documentElement.dataset.theme;
  } else if (mode === 'light' || mode === 'dark') {
    localStorage.setItem(KEY, mode);
    document.documentElement.dataset.theme = mode;
  } else {
    return;
  }
  refreshState();
};

const refreshState = () => {
  const wrap = document.getElementById('theme-toggle');
  if (wrap) wrap.dataset.state = get();
};

const renderToggle = wrap => {
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Color theme');
  wrap.dataset.state = get();
  wrap.innerHTML = `
    <button type="button" data-mode="auto"  title="Auto"  aria-label="Auto theme">${ICONS.auto}</button>
    <button type="button" data-mode="light" title="Light" aria-label="Light theme">${ICONS.light}</button>
    <button type="button" data-mode="dark"  title="Dark"  aria-label="Dark theme">${ICONS.dark}</button>
  `;
  wrap.addEventListener('click', e => {
    const btn = e.target.closest('button[data-mode]');
    if (btn) apply(btn.dataset.mode);
  });
};

const init = () => {
  const wrap = document.getElementById('theme-toggle');
  if (wrap) renderToggle(wrap);
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
