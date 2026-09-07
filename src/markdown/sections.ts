import {maskCodeRegions} from './wikilinks.ts';

/** An ATX heading line as the vault writes them: `#`s at column 0, a space, text. */
export const HEADING_LINE_RE = /^(#{1,6})[ \t]+\S/;

export interface SectionSpan {
  /** The heading line as it stands in the body, trimmed. */
  heading: string;
  level: number;
  /** Offset of the heading line's first character. */
  headingStart: number;
  /** Offset just past the heading line, its newline excluded. */
  headingEnd: number;
  /** Offset where the next heading of the same or higher level starts, or the body length. */
  end: number;
}

export type SectionLookup = {ok: true; span: SectionSpan} | {ok: false; occurrences: number};

/**
 * Locate the section under `heading`: the heading is matched as a whole line,
 * exactly once, with fenced and inline code masked so a `## ` inside a code
 * sample is not a heading. The section runs to the next heading of the same
 * or higher level, so subsections belong to it.
 */
export const findSection = (body: string, heading: string): SectionLookup => {
  const wanted = heading.trim();
  const rawLines = body.split('\n');
  const maskedLines = maskCodeRegions(body).split('\n');
  const headings: Array<{index: number; level: number; offset: number}> = [];
  let offset = 0;
  for (let i = 0; i < rawLines.length; ++i) {
    const match = HEADING_LINE_RE.exec(maskedLines[i] ?? '');
    if (match) headings.push({index: i, level: match[1]!.length, offset});
    offset += (rawLines[i] ?? '').length + 1;
  }
  const hits = headings.filter(h => (rawLines[h.index] ?? '').trim() === wanted);
  if (hits.length !== 1) return {ok: false, occurrences: hits.length};
  const hit = hits[0]!;
  const line = rawLines[hit.index] ?? '';
  let end = body.length;
  for (const h of headings) {
    if (h.offset > hit.offset && h.level <= hit.level) {
      end = h.offset;
      break;
    }
  }
  return {
    ok: true,
    span: {
      heading: line.trim(),
      level: hit.level,
      headingStart: hit.offset,
      headingEnd: hit.offset + line.length,
      end
    }
  };
};

/** The section's content between its heading line and the next heading, trimmed. */
export const sectionContent = (body: string, span: SectionSpan): string =>
  body.slice(span.headingEnd, span.end).trim();

/**
 * The body with the section's content replaced. Every byte outside the span
 * is untouched; inside it the content is trimmed and framed by blank lines so
 * the next heading never glues to it. An empty content keeps the heading.
 */
export const replaceSectionContent = (body: string, span: SectionSpan, content: string): string => {
  const inner = content.trim();
  const last = span.end === body.length;
  let framed: string;
  if (inner.length === 0) framed = last ? '\n' : '\n\n';
  else framed = last ? `\n\n${inner}\n` : `\n\n${inner}\n\n`;
  return body.slice(0, span.headingEnd) + framed + body.slice(span.end);
};
