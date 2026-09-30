// The lint checks nothing else in the UI acts on, for the lint-review page
// (D113). Pure: a /system/lint answer in, HTML strings out.

/** Fixed by the dashboard's Re-embed and Clean now actions. */
export const DASHBOARD_FIXED = new Set([
  'embedding_hash_drift',
  'records_without_embeddings',
  'orphan_embeddings',
  'orphan_doc_embeddings',
  'orphan_suggestions'
]);

/** Reviewed in the lint-review page's own sections. */
export const PAGE_SECTIONS = new Set(['dangling_tag_aliases', 'temporal_anomalies']);

/** The non-zero checks neither covers, as [name, check] in the server's order. */
export const otherChecks = lint =>
  Object.entries(lint.checks ?? {}).filter(
    ([name, c]) => c.count > 0 && !DASHBOARD_FIXED.has(name) && !PAGE_SECTIONS.has(name)
  );

// A sample with `id: null` names a file with no record, so no note page to link.
const cell = (sample, key, esc) => {
  const value = sample[key];
  if (value === null || value === undefined) return '<td>—</td>';
  if (key === 'file_path' && sample.id !== null) {
    const href = `/ui/note.html?path=${encodeURIComponent(value)}`;
    return `<td class="path"><a href="${href}">${esc(value)}</a></td>`;
  }
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `<td class="${key === 'file_path' ? 'path' : ''}">${esc(text)}</td>`;
};

/** One card per check: its count, and its samples as a table of their fields. */
export const renderOtherChecks = (checks, esc) =>
  checks
    .map(([name, {count, samples = []}]) => {
      const keys = [...new Set(samples.flatMap(s => Object.keys(s)))];
      const head = keys.map(k => `<th>${esc(k)}</th>`).join('');
      const rows = samples.map(s => `<tr>${keys.map(k => cell(s, k, esc)).join('')}</tr>`).join('');
      const table = keys.length
        ? `<div class="fmw-scroll"><table class="fmw-table wide small wrap"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`
        : '';
      const more =
        count > samples.length
          ? `<div class="why">Showing ${samples.length} of ${count} (capped server-side).</div>`
          : '';
      return `<section class="fmw-card" data-section="${esc(name)}"><h2><code>${esc(name)}</code> <span class="fmw-count">${count}</span></h2>${table}${more}</section>`;
    })
    .join('');
