// Inline SVG charts for the fleet pages: one series each, marks in the accent,
// de-emphasis in the muted ink. Builders return markup; bindTips() adds the
// hover layer to any element carrying `data-tip`.

import {esc} from '/ui/api.js';
import {compact, percent} from '/ui/fleet-digest.js';

const STYLE = `
.viz { display: block; max-width: 100%; overflow: visible; }
.viz .mark { fill: var(--accent); }
.viz .spark { fill: none; stroke: var(--muted); stroke-width: 1.5; stroke-linejoin: round; stroke-linecap: round; }
.viz .wash { fill: var(--accent); opacity: 0.1; }
.viz .line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.viz .dot { fill: var(--accent); stroke: var(--card); stroke-width: 2; }
.viz .grid { stroke: var(--line); stroke-width: 1; }
.viz .tick { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.viz .publish { stroke: var(--muted); stroke-width: 2; stroke-linecap: round; }
.viz .hit { fill: transparent; }
.viz .col:hover .mark { opacity: 0.75; }
.majors { display: grid; grid-template-columns: max-content minmax(6rem, 1fr) max-content; gap: 0.25rem 0.6rem; align-items: center; font-size: 0.85rem; }
.majors .track { display: block; height: 8px; border-radius: 4px; background: var(--line); overflow: hidden; }
.majors .fill { display: block; height: 100%; border-radius: 4px; background: var(--muted); }
.majors .fill.latest { background: var(--accent); }
.majors .v { text-align: right; font-variant-numeric: tabular-nums; }
.viz-tip { position: fixed; z-index: 50; pointer-events: none; background: var(--card); color: var(--fg); border: 1px solid var(--line); border-radius: 4px; padding: 0.3rem 0.5rem; font-size: 0.8rem; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15); max-width: 20rem; }
.viz-tip b { font-variant-numeric: tabular-nums; }
.viz-tip div + div { color: var(--muted); }
`;

let styled = false;
const ensureStyle = () => {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.textContent = STYLE;
  document.head.append(el);
};

const niceMax = max => {
  if (!(max > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= max) return m * p;
  return 10 * p;
};

// A bar with a rounded data end and a square foot on the baseline.
const barPath = (x, y, w, base) => {
  const r = Math.min(4, w / 2, base - y);
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
};

const tipAttr = lines => `data-tip="${esc(JSON.stringify(lines))}"`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = day => MONTHS[Number(day.slice(5, 7)) - 1];
export const monthDay = day => (day ? `${monthLabel(day)} ${Number(day.slice(8, 10))}` : '');
export const dayLabel = day =>
  day ? `${monthLabel(day)} ${Number(day.slice(8, 10))}, ${day.slice(0, 4)}` : '';
export const rangeLabel = (start, end) => {
  if (!start || !end) return '';
  const sameYear = start.slice(0, 4) === end.slice(0, 4),
    sameMonth = sameYear && start.slice(5, 7) === end.slice(5, 7);
  return sameMonth
    ? `${monthLabel(start)} ${Number(start.slice(8, 10))}–${Number(end.slice(8, 10))}, ${end.slice(0, 4)}`
    : `${monthLabel(start)} ${Number(start.slice(8, 10))}${sameYear ? '' : `, ${start.slice(0, 4)}`} – ${dayLabel(end)}`;
};

// A table-cell trend: the shape only, zero-based so noise is not magnified,
// the last week marked in the accent.
export const sparkline = (values, {width = 96, height = 22, label = ''} = {}) => {
  ensureStyle();
  if (!values?.length) return '';
  const max = Math.max(...values, 1),
    step = values.length > 1 ? (width - 4) / (values.length - 1) : 0;
  const pts = values.map((v, i) => [2 + i * step, height - 2 - (v / max) * (height - 4)]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const [lx, ly] = pts[pts.length - 1];
  return `<svg class="viz" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><path class="spark" d="${d}"/><circle class="dot" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3"/></svg>`;
};

// Weekly downloads as columns, a tick under each week that saw a publish.
export const weeklyBars = (weekly, ends, publishes = [], {width = 720, height = 180} = {}) => {
  ensureStyle();
  if (!weekly?.length) return '';
  const left = 44,
    right = 6,
    top = 8,
    bottom = 34;
  const plotW = width - left - right,
    base = height - bottom;
  const max = niceMax(Math.max(...weekly));
  const slot = plotW / weekly.length,
    barW = Math.max(2, Math.min(24, slot - 2));
  const byWeek = new Map();
  for (const [day, version] of publishes) {
    const i = ends.findIndex(end => day <= end);
    if (i >= 0) byWeek.set(i, [...(byWeek.get(i) ?? []), version]);
  }
  const parts = [];
  for (const f of [0, 0.5, 1]) {
    const y = base - f * (base - top);
    parts.push(
      `<line class="grid" x1="${left}" x2="${width - right}" y1="${y}" y2="${y}"/><text class="tick" x="${left - 6}" y="${y + 4}" text-anchor="end">${esc(compact(max * f))}</text>`
    );
  }
  weekly.forEach((v, i) => {
    const x = left + i * slot + (slot - barW) / 2,
      y = base - (v / max) * (base - top);
    const versions = byWeek.get(i) ?? [];
    const tip = [
      v.toLocaleString('en-US'),
      `week ending ${dayLabel(ends[i])}`,
      ...(versions.length ? [`published ${versions.join(', ')}`] : [])
    ];
    parts.push(
      `<g class="col" ${tipAttr(tip)}><rect class="hit" x="${left + i * slot}" y="${top}" width="${slot}" height="${base - top + 14}"/>${v > 0 ? `<path class="mark" d="${barPath(x, y, barW, base)}"/>` : ''}${versions.length ? `<line class="publish" x1="${x + barW / 2}" x2="${x + barW / 2}" y1="${base + 5}" y2="${base + 11}"/>` : ''}</g>`
    );
    // Every other month, where a week first crosses into it; January carries the year.
    const month = ends[i]?.slice(0, 7),
      before = ends[i - 1]?.slice(0, 7);
    if (i > 0 && month && month !== before && Number(month.slice(5)) % 2 === 1)
      parts.push(
        `<text class="tick" x="${left + i * slot}" y="${height - 6}">${esc(monthLabel(ends[i]))}${month.endsWith('-01') ? ` ${month.slice(0, 4)}` : ''}</text>`
      );
  });
  return `<svg class="viz" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Weekly downloads, ${weekly.length} weeks"><title>Weekly downloads, ${weekly.length} weeks</title>${parts.join('')}</svg>`;
};

// Dependents over time as a step line; one point is not a line.
export const stepLine = (history, {width = 720, height = 120} = {}) => {
  ensureStyle();
  if (!history || history.length < 2) return '';
  const left = 44,
    right = 10,
    top = 10,
    bottom = 22;
  const t = day => Date.parse(`${day}T00:00:00Z`);
  const t0 = t(history[0][0]),
    t1 = t(history[history.length - 1][0]);
  const values = history.map(([, n]) => n);
  const lo = Math.min(...values),
    hi = Math.max(...values);
  const span = hi - lo || 1,
    min = Math.max(0, lo - span * 0.1),
    max = hi + span * 0.1;
  const x = day => left + ((t(day) - t0) / (t1 - t0 || 1)) * (width - left - right);
  const y = n => height - bottom - ((n - min) / (max - min || 1)) * (height - top - bottom);
  let d = `M${x(history[0][0])},${y(history[0][1])}`;
  for (let i = 1; i < history.length; ++i) d += `H${x(history[i][0])}V${y(history[i][1])}`;
  const [lastDay, lastN] = history[history.length - 1];
  const hits = history
    .map(([day, n], i) => {
      const x0 = i ? (x(history[i - 1][0]) + x(day)) / 2 : left,
        x1 = i < history.length - 1 ? (x(day) + x(history[i + 1][0])) / 2 : width - right;
      return `<rect class="hit" x="${x0}" y="${top}" width="${Math.max(1, x1 - x0)}" height="${height - top - bottom}" ${tipAttr([n.toLocaleString('en-US'), dayLabel(day)])}/>`;
    })
    .join('');
  return `<svg class="viz" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Dependents over time"><title>Dependents over time</title>
<line class="grid" x1="${left}" x2="${width - right}" y1="${y(hi)}" y2="${y(hi)}"/><text class="tick" x="${left - 6}" y="${y(hi) + 4}" text-anchor="end">${esc(compact(hi))}</text>
<line class="grid" x1="${left}" x2="${width - right}" y1="${y(lo)}" y2="${y(lo)}"/><text class="tick" x="${left - 6}" y="${y(lo) + 4}" text-anchor="end">${esc(compact(lo))}</text>
<text class="tick" x="${left}" y="${height - 4}">${esc(dayLabel(history[0][0]))}</text><text class="tick" x="${width - right}" y="${height - 4}" text-anchor="end">${esc(dayLabel(lastDay))}</text>
<path class="line" d="${d}"/><circle class="dot" cx="${x(lastDay)}" cy="${y(lastN)}" r="4"/>${hits}</svg>`;
};

// Shares by major as labeled rows: the latest major in the accent, the rest gray.
export const majorRows = rows => {
  ensureStyle();
  if (!rows?.length) return '';
  return `<div class="majors">${rows
    .map(
      r =>
        `<span>${esc(r.label)}${r.latest ? ' (latest)' : ''}</span><span class="track"><span class="fill${r.latest ? ' latest' : ''}" style="width:${(100 * r.share).toFixed(2)}%"></span></span><span class="v">${esc(percent(r.share))}</span>`
    )
    .join('')}</div>`;
};

// One tooltip for the page: the first line is the value, the rest the context.
export const bindTips = root => {
  ensureStyle();
  let tip = document.querySelector('.viz-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'viz-tip';
    tip.hidden = true;
    document.body.append(tip);
  }
  root.addEventListener('pointermove', e => {
    const el = e.target.closest?.('[data-tip]');
    if (!el || !root.contains(el)) {
      tip.hidden = true;
      return;
    }
    let lines;
    try {
      lines = JSON.parse(el.dataset.tip);
    } catch {
      tip.hidden = true;
      return;
    }
    tip.replaceChildren(
      ...lines.map((line, i) => {
        const div = document.createElement('div');
        if (i === 0) {
          const b = document.createElement('b');
          b.textContent = line;
          div.append(b);
        } else div.textContent = line;
        return div;
      })
    );
    tip.hidden = false;
    const pad = 12,
      w = tip.offsetWidth,
      h = tip.offsetHeight;
    tip.style.left = `${Math.min(e.clientX + pad, window.innerWidth - w - 4)}px`;
    tip.style.top = `${Math.max(4, e.clientY - h - pad)}px`;
  });
  root.addEventListener('pointerleave', () => {
    tip.hidden = true;
  });
};
