// A GET /history/diff word diff (D138) as HTML. Pure: git's
// --word-diff=porcelain text in, an HTML string out.

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The hunks, each `{from, to, lines}`: the first line on each side, and its
 * lines as runs of `[kind, text]`, kind ' ' kept, '-' removed, '+' added.
 */
export const parseWordDiff = text => {
  const hunks = [];
  let hunk = null;
  let line = [];
  const flush = () => {
    if (hunk && line.length > 0) hunk.lines.push(line);
    line = [];
  };
  for (const raw of text.split('\n')) {
    const head = HUNK.exec(raw);
    if (head) {
      flush();
      hunk = {from: Number(head[1]), to: Number(head[2]), lines: []};
      hunks.push(hunk);
    } else if (!hunk) {
      continue;
    } else if (raw === '~') {
      hunk.lines.push(line);
      line = [];
    } else if (raw[0] === ' ' || raw[0] === '-' || raw[0] === '+') {
      line.push([raw[0], raw.slice(1)]);
    }
  }
  flush();
  return hunks;
};

const lineClass = runs =>
  runs.length > 0 && runs.every(([k]) => k === '-')
    ? ' removed'
    : runs.length > 0 && runs.every(([k]) => k === '+')
      ? ' added'
      : '';

const renderRun = ([kind, text], esc) =>
  kind === '-' ? `<del>${esc(text)}</del>` : kind === '+' ? `<ins>${esc(text)}</ins>` : esc(text);

/** Each hunk under the line it starts at on the newer side, or on the older when nothing is left. */
export const renderWordDiff = (text, esc) => {
  const hunks = parseWordDiff(text);
  if (hunks.length === 0) return '<p class="empty">No differences.</p>';
  return hunks
    .map(
      h =>
        `<div class="hunk"><div class="hunk-head">Line ${h.to > 0 ? h.to : h.from}</div><div class="diff">${h.lines
          .map(
            runs =>
              `<div class="dl${lineClass(runs)}">${runs.map(r => renderRun(r, esc)).join('')}</div>`
          )
          .join('')}</div></div>`
    )
    .join('');
};
