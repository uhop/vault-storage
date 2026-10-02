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
    ${v.author ? `<span class="author">${esc(v.author)}</span>` : ''}
    <span class="subject">${esc(v.subject)}</span>
    ${v.path === notePath ? '' : `<small class="path">${esc(v.path)}</small>`}
  </button></li>`
    )
    .join('')}</ol>`;

/** A version's views beside its content: its changes, and against the note now (D138). */
export const renderViewSwitch = view => `<vault-switch id="view-switch" aria-label="View"${
  view === 'restore' ? '' : ` value="${view}"`
}>
  <button data-value="content">Content</button>
  <button data-value="changes">Changes</button>
  <button data-value="current">With current</button>
</vault-switch>`;

/**
 * The word diff a view shows: `changes` from the version before, `current` from
 * the version to the note on disk, `restore` from the note on disk to the version.
 */
export const diffUrl = (notePath, v, view) => {
  const sides =
    view === 'changes'
      ? `to=${v.sha}&to_path=${encodeURIComponent(v.path)}`
      : view === 'current'
        ? `from=${v.sha}&from_path=${encodeURIComponent(v.path)}`
        : `from=current&to=${v.sha}&to_path=${encodeURIComponent(v.path)}`;
  return `/history/diff?path=${encodeURIComponent(notePath)}&${sides}&format=words`;
};

/** The restore's own confirmation, above the diff it applies. */
export const renderRestorePrompt = (v, esc) => `<div class="fmw-notice restore-prompt">
  <p>Restoring writes the version of ${esc(shortDate(v.date))} over the note: the struck-out text goes and the underlined text comes in. The current content stays in the history as a version.</p>
  <button id="confirm-restore" class="primary">Restore</button>
  <button id="cancel-restore">Cancel</button>
</div>`;

/** The chosen version's header, with Restore unless the commit deleted the note. */
export const renderVersionHead = (v, esc) => {
  const deleted = v.change === 'deleted';
  return `<div class="version-head">
  <div><b>${esc(shortDate(v.date))}</b> <code>${esc(v.sha.slice(0, 8))}</code>${v.author ? ` by ${esc(v.author)}` : ''} ${esc(v.subject)}</div>
  <button id="restore" class="primary" ${deleted ? 'disabled' : ''}>Restore this version</button>
</div>${deleted ? '<p class="why">This commit deleted the note; the version before it holds its last content.</p>' : ''}`;
};
