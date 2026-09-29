// The typed edges of a note, grouped for the note page's Links block and its
// notices (D86). Pure: a depth-1 neighborhood in, HTML strings out.

export const TYPE_ORDER = [
  'supersedes',
  'revises',
  'contradicts',
  'rejected-because',
  'fixed-by',
  'caused-by',
  'derived-from',
  'applies-to',
  'cites',
  'related-to'
];

/** Types whose lists run long on a hub note; shown folded past SHOW_FIRST. */
export const BULK_TYPES = new Set(['cites', 'related-to']);

/** Stored mirrored, so each neighbour is listed once, under `out`. */
export const SYMMETRIC_TYPES = new Set(['related-to']);

export const SHOW_FIRST = 8;

export const titleOf = r => r.title || r.file_path.split('/').pop().replace(/\.md$/, '');

/**
 * Group the root's edges by type: [{type, out, in}], types in TYPE_ORDER
 * with unknown ones after, each list sorted by title. `out` holds the
 * records this note points at, `in` those pointing at it.
 */
export const groupLinks = (rootId, neighborhood) => {
  const byId = new Map();
  for (const layer of neighborhood.layers ?? []) {
    for (const r of layer.records ?? []) byId.set(r.record_id, r);
  }
  const groups = new Map();
  const bucket = type => {
    let g = groups.get(type);
    if (!g) {
      g = {type, out: [], in: [], seen: new Set()};
      groups.set(type, g);
    }
    return g;
  };
  for (const e of neighborhood.edges ?? []) {
    const outbound = e.from_id === rootId;
    if (!outbound && e.to_id !== rootId) continue;
    const otherId = outbound ? e.to_id : e.from_id;
    if (otherId === rootId) continue;
    const other = byId.get(otherId);
    if (!other) continue;
    const g = bucket(e.type);
    const entry = {...other, note: e.note ?? null};
    if (SYMMETRIC_TYPES.has(e.type)) {
      if (g.seen.has(otherId)) continue;
      g.seen.add(otherId);
      g.out.push(entry);
    } else {
      (outbound ? g.out : g.in).push(entry);
    }
  }
  const byTitle = (a, b) => titleOf(a).localeCompare(titleOf(b));
  const order = [
    ...TYPE_ORDER.filter(t => groups.has(t)),
    ...[...groups.keys()].filter(t => !TYPE_ORDER.includes(t))
  ];
  return order.map(t => {
    const g = groups.get(t);
    return {type: t, out: g.out.sort(byTitle), in: g.in.sort(byTitle)};
  });
};

/** The inbound edges a reader should see before the note: what supersedes or contradicts it. */
export const warnings = groups =>
  groups
    .filter(g => (g.type === 'supersedes' || g.type === 'contradicts') && g.in.length > 0)
    .map(g => ({type: g.type, records: g.in}));

const noteLink = (r, esc) =>
  `<a href="/ui/note.html?path=${encodeURIComponent(r.file_path)}"${r.note ? ` title="${esc(r.note)}"` : ''}>${esc(titleOf(r))}</a>`;

export const renderWarnings = (list, esc) =>
  list
    .map(w => {
      const verb = w.type === 'supersedes' ? 'Superseded by' : 'Contradicted by';
      return `<p class="fmw-notice links-warning">${verb} ${w.records.map(r => noteLink(r, esc)).join(', ')}.</p>`;
    })
    .join('');

const renderList = (records, esc) => {
  if (records.length === 0) return '';
  const items = records.map(r => `<li>${noteLink(r, esc)}<small>${esc(r.file_path)}</small></li>`);
  if (records.length <= SHOW_FIRST) return `<div class="list"><ul>${items.join('')}</ul></div>`;
  const rest = records.length - SHOW_FIRST;
  return `<div class="list"><ul>${items.slice(0, SHOW_FIRST).join('')}</ul><details class="more"><summary>${rest} more</summary><ul>${items.slice(SHOW_FIRST).join('')}</ul></details></div>`;
};

/**
 * The Links block: a summary line counting each type, then per type the
 * notes this one points at (→) and the notes pointing at it (←). Open when
 * the note has an edge outside the bulk types.
 */
export const renderLinks = (groups, esc) => {
  if (groups.length === 0) return '';
  const counts = groups.map(g => `${esc(g.type)} ${g.out.length + g.in.length}`).join(' · ');
  const open = groups.some(g => !BULK_TYPES.has(g.type)) ? ' open' : '';
  const body = groups
    .map(g => {
      const out = renderList(g.out, esc);
      const inbound = renderList(g.in, esc);
      const symmetric = SYMMETRIC_TYPES.has(g.type);
      return `<div class="type"><b>${esc(g.type)}</b>${
        out
          ? `<div class="dir"><span class="arrow">${symmetric ? '↔' : '→'}</span>${out}</div>`
          : ''
      }${inbound ? `<div class="dir"><span class="arrow">←</span>${inbound}</div>` : ''}</div>`;
    })
    .join('');
  return `<details class="links"${open}><summary>Links · ${counts}</summary>${body}</details>`;
};
