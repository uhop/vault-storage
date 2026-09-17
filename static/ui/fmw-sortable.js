// Column sorting for a data table: one sort per table, remembered per viewer,
// and a column without a `value` accessor never sorts. The page owns its
// tables — columns as {key, label, value?, text?, n?}, a `storage` key, a
// `fallback` sort, and a `tie` breaker — and the rendering; this owns the
// state, the order, the header cells, and the delegated header clicks and
// keys. Part of the framework (design/ui-css-component-system).

// Relative, so the module loads under the test server's /static/ui/ path as well.
import {esc} from './api.js';

export const sortable = tables => {
  const state = table => {
    const t = tables[table];
    try {
      const s = JSON.parse(localStorage.getItem(t.storage));
      if (t.columns.some(c => c.key === s?.key && c.value)) return s;
    } catch {}
    return t.fallback;
  };

  // Sorts `rows` in place by the remembered column and returns the sort.
  const rows = (table, list) => {
    const t = tables[table],
      sort = state(table);
    const col = t.columns.find(c => c.key === sort.key);
    const sign = sort.dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      const x = col.value(a),
        y = col.value(b);
      const d = col.text ? String(x).localeCompare(String(y)) : x - y;
      return sign * d || t.tie(a).localeCompare(t.tie(b));
    });
    return sort;
  };

  // The <th> cells: a sortable one carries its table and key, the current one its direction.
  const head = (table, sort, extra = () => '') =>
    tables[table].columns
      .map(
        c =>
          `<th class="${c.n ? 'n ' : ''}${c.value ? 'sortable' : ''}" ${c.value ? `data-table="${table}" data-sort="${c.key}" aria-sort="${sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}" tabindex="0"` : ''}>${c.label.split('\n').map(esc).join('<br>')}${extra(c)}</th>`
      )
      .join('');

  // Delegated on the container, since the table re-renders; `render(table)` redraws it.
  const bind = (container, render) => {
    const sortBy = th => {
      const table = th.dataset.table,
        key = th.dataset.sort;
      const s = state(table),
        col = tables[table].columns.find(c => c.key === key);
      const dir = s.key === key ? (s.dir === 'asc' ? 'desc' : 'asc') : col.text ? 'asc' : 'desc';
      try {
        localStorage.setItem(tables[table].storage, JSON.stringify({key, dir}));
      } catch {}
      render(table);
    };
    container.addEventListener('click', e => {
      const th = e.target.closest('th[data-sort]');
      if (th) sortBy(th);
    });
    container.addEventListener('keydown', e => {
      const th = e.target.closest('th[data-sort]');
      if (th && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        sortBy(th);
      }
    });
  };

  return {state, rows, head, bind};
};
