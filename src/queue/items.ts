import {findSection} from '../markdown/sections.ts';
import {maskCodeRegions} from '../markdown/wikilinks.ts';
import {normalizeTitle} from './parse.ts';

// One queue item as the parser sees it: a column-0 bullet line and every line
// after it up to the next column-0 bullet or any heading (blank lines and
// prose in between belong to the item, as `parseQueueFile` attributes them).

const BULLET_RE = /^[-*+]\s/;
const HEADING_RE = /^#{1,6}\s/;
const BOLD_TITLE_RE = /^[-*+]\s+(?:\[[ xX~]\]\s+)?\*\*((?:[^*]|\*(?!\*))+?\*?)\*\*/;

export interface ItemSpan {
  /** The bold title as written. */
  title: string;
  /** First line of the item (0-based). */
  start: number;
  /** One past the last line of the item, trailing blank lines included. */
  end: number;
}

export type ItemLookup = {ok: true; span: ItemSpan} | {ok: false; occurrences: number};

const structuralLines = (body: string): {raw: string[]; masked: string[]} => ({
  raw: body.split('\n'),
  masked: maskCodeRegions(body).split('\n')
});

/**
 * Locate the item whose bold title normalizes to `title`, exactly once, in
 * the whole body or inside the section under `heading`.
 */
export const findItem = (body: string, title: string, heading?: string): ItemLookup => {
  const {raw, masked} = structuralLines(body);
  let from = 0;
  let to = raw.length;
  if (heading !== undefined) {
    const section = findSection(body, heading);
    if (!section.ok) return {ok: false, occurrences: 0};
    from = body.slice(0, section.span.headingEnd).split('\n').length;
    to =
      body.slice(0, section.span.end).split('\n').length -
      (section.span.end === body.length ? 0 : 1);
  }
  const wanted = normalizeTitle(title);
  const starts: number[] = [];
  for (let i = from; i < to; ++i) {
    if (!BULLET_RE.test(masked[i] ?? '')) continue;
    const m = BOLD_TITLE_RE.exec(raw[i] ?? '');
    if (m && normalizeTitle(m[1] ?? '') === wanted) starts.push(i);
  }
  if (starts.length !== 1) return {ok: false, occurrences: starts.length};
  const start = starts[0]!;
  let end = raw.length;
  for (let i = start + 1; i < raw.length; ++i) {
    const line = masked[i] ?? '';
    if (BULLET_RE.test(line) || HEADING_RE.test(line)) {
      end = i;
      break;
    }
  }
  const m = BOLD_TITLE_RE.exec(raw[start] ?? '');
  return {ok: true, span: {title: m?.[1] ?? '', start, end}};
};

/** The item block, trailing blank lines dropped. */
export const itemText = (body: string, span: ItemSpan): string =>
  body.split('\n').slice(span.start, span.end).join('\n').replace(/\s+$/, '');

/** The body without the item; a document that ends there keeps one newline. */
export const removeItem = (body: string, span: ItemSpan): string => {
  const lines = body.split('\n');
  const out = [...lines.slice(0, span.start), ...lines.slice(span.end)];
  return out
    .join('\n')
    .replace(/\n{3,}$/, '\n\n')
    .replace(/\s+$/, '\n');
};

/** `trail` right after the bold title's closing `**`, one space before it. */
export const withTrail = (item: string, trail: string): string => {
  const m = BOLD_TITLE_RE.exec(item);
  if (!m) return item;
  const cut = m[0].length;
  const spaced = trail.startsWith(' ') ? trail : ` ${trail}`;
  return item.slice(0, cut) + spaced + item.slice(cut);
};

export type InsertOutcome =
  {ok: true; body: string; created: boolean} | {ok: false; occurrences: number};

const EMPTY_PLACEHOLDER = /^\s*\(empty\)\s*$/;

/**
 * Put `item` at the start or end of the section under `heading`, framed by
 * blank lines; an `(empty)` placeholder is replaced. With `createSection`
 * a missing heading is added before the first heading of the same level
 * (a newest-first archive's new date block), or at the end when none exists.
 */
export const insertItem = (
  body: string,
  heading: string,
  item: string,
  position: 'start' | 'end',
  createSection: boolean
): InsertOutcome => {
  const block = item.trim();
  const section = findSection(body, heading);
  if (!section.ok) {
    if (!createSection || section.occurrences !== 0) {
      return {ok: false, occurrences: section.occurrences};
    }
    const level = /^#+/.exec(heading.trim())?.[0].length ?? 2;
    const {masked} = structuralLines(body);
    const lines = body.split('\n');
    const at = masked.findIndex(l => new RegExp(`^#{1,${level}}\\s`).test(l));
    const fresh = [`${heading.trim()}`, '', block, ''];
    const out =
      at === -1
        ? [...lines.join('\n').replace(/\s+$/, '').split('\n'), '', ...fresh]
        : [...lines.slice(0, at), ...fresh, ...lines.slice(at)];
    return {ok: true, body: out.join('\n').replace(/\s+$/, '\n'), created: true};
  }
  const {span} = section;
  const before = body.slice(0, span.headingEnd);
  const content = body.slice(span.headingEnd, span.end);
  const after = body.slice(span.end);
  const inner = content.replace(/^\n+/, '').replace(/\s+$/, '');
  const last = span.end === body.length;
  let merged: string;
  if (inner.length === 0 || EMPTY_PLACEHOLDER.test(inner)) merged = block;
  else merged = position === 'start' ? `${block}\n\n${inner}` : `${inner}\n\n${block}`;
  const framed = last ? `\n\n${merged}\n` : `\n\n${merged}\n\n`;
  return {ok: true, body: before + framed + after, created: false};
};
