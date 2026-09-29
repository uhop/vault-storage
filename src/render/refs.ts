// Short references in note text: `#233`, `owner/repo#233`, and a tracker key
// such as `ENG-123`. The render marks each candidate and the server resolves
// the marks per request, since what a reference means (the project's trackers,
// the titles the vault has collected) changes without the note changing, and a
// render is cached by its body.

export type Ref =
  /** `repo` null means the note's own repository. */
  {kind: 'number'; repo: string | null; n: number} | {kind: 'key'; prefix: string; n: number};

export interface RefLink {
  url: string;
  title: string | null;
  state: string | null;
}

export type ResolveRef = (ref: Ref) => RefLink | null;

const NUMBER = String.raw`(?:[\w.-]+\/[\w.-]+)?#[1-9]\d{0,8}(?!\w)`;
const KEY = String.raw`[A-Z][A-Z0-9]{1,9}-[1-9]\d{0,8}(?!\w)`;

/** Where the next candidate starts; the lookbehinds keep `abc#5`, `a/b/c#5`, `&#5;`, and `X-UTF-8` text. */
export const REF_START = new RegExp(String.raw`(?<![\w/&#.-])${NUMBER}|(?<![\w-])${KEY}`);
export const REF = new RegExp(`^(?:${NUMBER}|${KEY})`);
/** A preceding text run ending in one of these makes the candidate part of a word, a path, or an entity. */
export const REF_BLOCKED = /[\w/&#.-]$/;

const PARTS = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$|^([A-Z][A-Z0-9]+)-(\d+)$/;
const MARK = /<span data-ref="([^"]+)">[^<]*<\/span>/g;

const esc = (s: string): string =>
  s.replace(
    /[<>&"']/g,
    c => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;'})[c]!
  );

/** `raw` matched {@link REF}, so it holds only word characters, `.`, `-`, `/`, and `#`. */
export const refMark = (raw: string): string => `<span data-ref="${raw}">${raw}</span>`;

export const parseRef = (raw: string): Ref | null => {
  const m = PARTS.exec(raw);
  if (!m) return null;
  if (m[3] !== undefined) return {kind: 'key', prefix: m[3], n: Number(m[4])};
  return {kind: 'number', repo: m[1] ?? null, n: Number(m[2])};
};

/** Each mark becomes a link with the title as its text, or the plain reference when nothing resolves it. */
export const resolveRefs = (html: string, resolve: ResolveRef): string => {
  if (!html.includes('<span data-ref="')) return html;
  return html.replace(MARK, (_, raw: string) => {
    const ref = parseRef(raw);
    const link = ref && resolve(ref);
    if (!link) return raw;
    const text = link.title === null ? raw : `${raw} ${esc(link.title)}`;
    const state = link.state === null ? '' : ` data-state="${esc(link.state)}"`;
    return `<a class="ref" href="${esc(link.url)}"${state}>${text}</a>`;
  });
};
