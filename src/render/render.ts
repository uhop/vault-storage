import {Marked, type Tokens} from 'marked';
import {WikilinkResolver} from '../importer/resolver.ts';
import {scanHeadings} from '../markdown/sections.ts';

export interface PathEntry {
  recordId: string;
  filePath: string;
}

/** The record path a wikilink target resolves to, or null. */
export type ResolveLink = (target: string) => string | null;

export interface RenderedSection {
  /** The heading line, trimmed, as `replace-section` matches it. */
  heading: string;
  level: number;
  /** One-based line in the document. */
  line: number;
  /** How many identical heading lines precede this one. */
  occurrence: number;
}

export interface Rendered {
  html: string;
  sections: RenderedSection[];
}

export const noteUiUrl = (filePath: string): string =>
  `/ui/note.html?path=${encodeURIComponent(filePath)}`;

export const linkResolver = (entries: readonly PathEntry[]): ResolveLink => {
  const resolver = new WikilinkResolver(entries);
  const pathById = new Map(entries.map(e => [e.recordId, e.filePath]));
  return target => {
    const id = resolver.resolve(target);
    return id === null ? null : (pathById.get(id) ?? null);
  };
};

const esc = (s: string): string =>
  s.replace(
    /[<>&"']/g,
    c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'})[c]!
  );

const newlines = (s: string): number => {
  let n = 0;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) ++n;
  return n;
};

interface WikilinkToken extends Tokens.Generic {
  type: 'wikilink';
  raw: string;
  target: string;
  alias: string | null;
}

type LinedHeading = Tokens.Heading & {line?: number};

const WIKILINK = /^\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/;

// The options and wikilink syntax of static/ui/components/vault-markdown.js, so the page reads the same.
const makeMarked = (resolve: ResolveLink): Marked =>
  new Marked({
    gfm: true,
    breaks: false,
    extensions: [
      {
        name: 'wikilink',
        level: 'inline',
        start(src: string) {
          const i = src.indexOf('[[');
          return i === -1 ? undefined : i;
        },
        tokenizer(src: string): WikilinkToken | undefined {
          const m = WIKILINK.exec(src);
          if (!m) return undefined;
          return {type: 'wikilink', raw: m[0], target: m[1]!, alias: m[2] ?? null};
        },
        renderer(token) {
          const {target, alias} = token as WikilinkToken;
          const display = esc(alias ?? target);
          const filePath = resolve(target);
          if (filePath === null) {
            return `<a class="wikilink unresolved" data-wikilink="${esc(target)}" title="Wikilink not resolved">${display}</a>`;
          }
          return `<a class="wikilink" data-wikilink="${esc(target)}" href="${esc(noteUiUrl(filePath))}" title="${esc(filePath)}">${display}</a>`;
        }
      }
    ],
    renderer: {
      heading(token: LinedHeading) {
        if (token.line === undefined) return false;
        const text = this.parser.parseInline(token.tokens);
        return `<h${token.depth} data-line="${token.line}">${text}</h${token.depth}>\n`;
      }
    }
  });

/**
 * Render a note body to HTML, wikilinks resolved and every top-level heading
 * stamped with its document line, plus the body's sections as the section
 * editor addresses them. `firstLine` is the document line the body starts on.
 */
export const renderMarkdown = (body: string, firstLine: number, resolve: ResolveLink): Rendered => {
  const marked = makeMarked(resolve);
  const tokens = marked.lexer(body);
  let line = firstLine;
  for (const token of tokens) {
    if (token.type === 'heading') (token as LinedHeading).line = line;
    line += newlines(token.raw);
  }
  const html = marked.parser(tokens);
  const sections = scanHeadings(body).map(h => ({
    heading: h.heading,
    level: h.level,
    line: firstLine + h.index,
    occurrence: h.occurrence
  }));
  return {html, sections};
};
