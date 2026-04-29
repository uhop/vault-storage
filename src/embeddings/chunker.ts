// Markdown-aware body chunker. Each chunk stays within the BGE 512-token
// context window (~1500 chars conservatively). Chunks respect markdown
// structure: never cross a header, prefer paragraph boundaries, only
// hard-truncate when a single paragraph exceeds the budget.
//
// **Overlap.** When a section spans multiple chunks, the last block of one
// chunk is repeated as the first block of the next chunk (paragraph-level
// overlap). This avoids losing context that crosses a chunk boundary — a
// concept introduced at the end of chunk N and developed at the start of
// chunk N+1 stays connected. Overlap never crosses a header boundary; a new
// section starts fresh. For hard-split single paragraphs, overlap is char-
// level (last `charOverlap` characters of the previous piece).

const DEFAULT_MAX_CHARS = 1200;     // soft target — paragraphs may push slightly past
const HARD_CAP = 1500;              // absolute upper bound per chunk
const DEFAULT_CHAR_OVERLAP = 150;   // for hard-split paragraphs
const HEADER_RE = /^(#{1,6})\s+(.*)$/;

interface HeaderFrame {
  level: number;
  title: string;
}

interface Block {
  /** Stack of active headers, outermost first. e.g. [{1,"Top"},{2,"Sub"}]. */
  headerPath: HeaderFrame[];
  /** Block body — one paragraph or one fenced code block. */
  text: string;
}

const samePath = (a: HeaderFrame[], b: HeaderFrame[]): boolean =>
  a.length === b.length && a.every((h, i) => h.level === b[i]!.level && h.title === b[i]!.title);

const splitBlocks = (body: string): Block[] => {
  const blocks: Block[] = [];
  const lines = body.split('\n');
  const stack: HeaderFrame[] = [];
  let buf: string[] = [];
  let inFence = false;

  const flush = (): void => {
    if (buf.length === 0) return;
    const text = buf.join('\n').trim();
    if (text) blocks.push({headerPath: stack.slice(), text});
    buf = [];
  };

  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      buf.push(line);
      continue;
    }
    if (inFence) {
      buf.push(line);
      continue;
    }
    const m = HEADER_RE.exec(line);
    if (m) {
      flush();
      const level = m[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({level, title: m[2]!.trim()});
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
};

const headerPrefix = (path: HeaderFrame[]): string =>
  path.length === 0 ? '' : path.map(h => h.title).join(' / ') + '\n\n';

const hardSplit = (text: string, cap: number, overlap: number): string[] => {
  if (cap <= overlap) return [text.slice(0, cap)];
  const stride = cap - overlap;
  const out: string[] = [];
  for (let i = 0; i < text.length; i += stride) {
    out.push(text.slice(i, i + cap));
    if (i + cap >= text.length) break;
  }
  return out;
};

/**
 * Split a markdown body into chunks. Each chunk fits within `maxChars`
 * (HARD_CAP at the absolute outer edge). Header path is prefixed onto each
 * chunk; in-section continuation uses paragraph-level overlap so concepts
 * crossing a chunk boundary remain connected.
 */
export const chunkBody = (
  body: string,
  opts: {maxChars?: number; charOverlap?: number; overlap?: boolean} = {}
): string[] => {
  const max = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const charOverlap = opts.charOverlap ?? DEFAULT_CHAR_OVERLAP;
  const overlapEnabled = opts.overlap !== false;
  if (!body || body.length <= max) return [body];

  const blocks = splitBlocks(body);
  if (blocks.length === 0) return [body.slice(0, HARD_CAP)];

  const chunks: string[] = [];
  let currentPath: HeaderFrame[] | null = null;
  let buf: string[] = [];
  let bufLen = 0;
  let lastBlockText: string | null = null;

  const flush = (): void => {
    if (buf.length === 0) return;
    const prefix = currentPath ? headerPrefix(currentPath) : '';
    chunks.push(prefix + buf.join('\n\n'));
    lastBlockText = buf[buf.length - 1] ?? null;
    buf = [];
    bufLen = 0;
  };

  const seedOverlap = (): void => {
    if (!overlapEnabled || !lastBlockText) return;
    buf.push(lastBlockText);
    bufLen = lastBlockText.length;
  };

  for (const block of blocks) {
    const inSameSection = currentPath !== null && samePath(currentPath, block.headerPath);
    if (!inSameSection) {
      flush();
      currentPath = block.headerPath;
      lastBlockText = null; // section change resets overlap
    }

    const prefixLen = headerPrefix(block.headerPath).length;
    const blockLen = block.text.length;

    // Block bigger than the cap on its own — hard-split it. Each split-piece
    // becomes its own chunk with the header prefix and char-level overlap.
    if (prefixLen + blockLen > HARD_CAP) {
      flush();
      const pieces = hardSplit(
        block.text,
        HARD_CAP - prefixLen,
        overlapEnabled ? charOverlap : 0
      );
      for (const piece of pieces) chunks.push(headerPrefix(block.headerPath) + piece);
      lastBlockText = pieces[pieces.length - 1] ?? null;
      currentPath = null; // next paragraph starts a fresh accumulation
      continue;
    }

    if (bufLen > 0 && prefixLen + bufLen + 2 + blockLen > max) {
      flush();
      currentPath = block.headerPath;
      seedOverlap();
    }
    buf.push(block.text);
    bufLen += (bufLen > 0 ? 2 : 0) + blockLen;
  }
  flush();
  return chunks;
};
