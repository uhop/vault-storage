// A note's versions for the history page (D116). Pure: a GET /history page in,
// HTML strings out.

export const PAGE_SIZE = 50;

export const encodePath = p => p.split('/').map(encodeURIComponent).join('/');

/** The commit time as git wrote it, to the minute. */
export const shortDate = iso => iso.slice(0, 16).replace('T', ' ');

/** Which slice is on screen; the route has no total, so the pager says whether there is more. */
export const rangeText = (offset, count) =>
  count === 0 ? 'No committed versions.' : `Versions ${offset + 1}–${offset + count}`;

/** The list: one button per version, its path shown when a rename came between. */
export const renderVersions = (items, notePath, selectedSha, esc) =>
  `<ol class="versions">${items
    .map(
      v => `<li><button class="version" data-sha="${esc(v.sha)}" aria-pressed="${v.sha === selectedSha}">
    <span class="when">${esc(shortDate(v.date))}</span>
    <span class="change ${esc(v.change)}">${esc(v.change)}</span>
    <span class="subject">${esc(v.subject)}</span>
    ${v.path === notePath ? '' : `<small class="path">${esc(v.path)}</small>`}
  </button></li>`
    )
    .join('')}</ol>`;

/** The chosen version's header, with Restore unless the commit deleted the note. */
export const renderVersionHead = (v, esc) => {
  const deleted = v.change === 'deleted';
  return `<div class="version-head">
  <div><b>${esc(shortDate(v.date))}</b> <code>${esc(v.sha.slice(0, 8))}</code> ${esc(v.subject)}</div>
  <button id="restore" class="primary" ${deleted ? 'disabled' : ''}>Restore this version</button>
</div>${deleted ? '<p class="why">This commit deleted the note; the version before it holds its last content.</p>' : ''}`;
};
