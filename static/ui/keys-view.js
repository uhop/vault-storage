// The keys page (D137). Pure: GET /keys and POST /keys answers in, HTML strings out.

export const KINDS = ['agent', 'person', 'system'];

const STATUS_CLASS = {active: 'fmw-ok', expired: 'fmw-warn', recalled: 'fmw-bad'};

/** A date to the day, or a dash. */
export const day = iso => (iso ? iso.slice(0, 10) : '—');

/** Newest first, the active ones before the rest. */
export const orderKeys = items =>
  [...items].sort(
    (a, b) =>
      Number(b.status === 'active') - Number(a.status === 'active') ||
      b.created.localeCompare(a.created)
  );

export const renderWhoAmI = (me, esc) =>
  me ? `This page uses the key <b>${esc(me.name)}</b> (${esc(me.kind)}).` : 'This page has no key.';

export const renderKeys = (items, esc) => {
  if (!items.length) return '<div class="empty">No named keys yet.</div>';
  return `<div class="fmw-scroll"><table class="fmw-table wide keys">
  <thead><tr><th>Name</th><th>Kind</th><th>Email</th><th>Status</th><th>Created</th><th>Expires</th><th></th></tr></thead>
  <tbody>${orderKeys(items)
    .map(
      k => `<tr data-id="${esc(k.id)}">
    <td>${esc(k.name)}</td>
    <td>${esc(k.kind)}</td>
    <td>${k.email ? esc(k.email) : '—'}</td>
    <td><span class="${STATUS_CLASS[k.status] ?? ''}">${esc(k.status)}</span>${k.recalled_at ? ` <small>${esc(day(k.recalled_at))}</small>` : ''}</td>
    <td>${esc(day(k.created))}</td>
    <td>${esc(day(k.expires_at))}</td>
    <td>${k.status === 'active' ? `<button class="recall danger" data-id="${esc(k.id)}" data-name="${esc(k.name)}">Recall</button>` : ''}</td>
  </tr>`
    )
    .join('')}</tbody>
</table></div>`;
};

/** The one place a new key's secret is shown. */
export const renderSecret = ({key, secret}, esc) => `<div class="fmw-notice ok secret">
  <p>The key <b>${esc(key.name)}</b> (${esc(key.kind)}) is made. Its secret is shown this once:</p>
  <p><code id="secret-text">${esc(secret)}</code> <button id="copy-secret">Copy</button></p>
  <p>Give it to the agent or the person as their bearer token, in place of the API token.</p>
</div>`;
