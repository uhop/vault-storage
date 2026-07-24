// Parse a project's queue.md / queue-archive.md into structured items.
//
// Source-of-truth shape lives in `topics/project-queue-convention` in the vault.
// queue.md has H2 sections Active / Backlog / Watching; Backlog optionally has
// H3 `### Priority +N` / `0` / `-N` subsections (a flat list under Backlog is
// implicit priority 0). queue-archive.md groups items under H2 date headings
// (`## YYYY-MM-DD`, `## Pre-YYYY-MM`, or `## Undated`), most recent first.
//
// Items are top-level bullets, typically `- **Title.** Description ...` with
// multi-line continuation, sub-bullets, and inline code allowed. Code-block
// regions are masked before structural detection so triple-backtick fences
// inside an item body don't confuse heading/bullet scanning.

import {createHash} from 'node:crypto';
import {parseFrontmatter} from '../markdown/frontmatter.ts';
import {maskCodeRegions} from '../markdown/wikilinks.ts';

export type QueueSection = 'active' | 'backlog' | 'watching' | 'archive';
export type CloseReason = 'shipped' | 'rejected' | 'parked' | 'deferred';

export interface ParsedQueueItem {
  project: string;
  section: QueueSection;
  /** ±N around 0; meaningful only when section === 'backlog'. */
  priority: number;
  /** 1-based within (project, section, priority). */
  position: number;
  /** Raw bolded portion, or the full first line minus the bullet marker. */
  title: string;
  /** Lowercased, whitespace-collapsed, hyphen-unified. */
  title_norm: string;
  /** Everything after the title on the first line + every continuation line, joined and trimmed. */
  body: string;
  /** YYYY-MM-DD when the archive heading parsed cleanly; null otherwise (archive Pre-/Undated, or non-archive). */
  closed_at: string | null;
  /** Regex-inferred from body when section === 'archive'; null in other sections or no match. */
  close_reason: CloseReason | null;
  source_file: string;
  /** 1-based line in the original `content` where the bullet starts. */
  source_line: number;
  /** sha256(title + '\0' + body), hex. */
  body_hash: string;
  /**
   * Raw refs from `blocked-by:` marker lines in the item body, in order of
   * appearance. Refs are normalized-title substrings (optionally
   * `<project>/`-prefixed), resolved at query time — see `ready.ts`.
   */
  blocked_by: string[];
}

const SECTION_HEADINGS: Record<string, Exclude<QueueSection, 'archive'>> = {
  active: 'active',
  backlog: 'backlog',
  watching: 'watching'
};

const PRIORITY_HEADING_RE = /^###\s+Priority\s+([+-]?\d+)\s*$/;
const H2_RE = /^##\s+(.+?)\s*$/;
const TOP_BULLET_RE = /^[-*+]\s+(.*)$/;
// Legacy checkbox marker, dropped per the 2026-05-13 convention rewrite but
// still present in many projects' queue files. Parser strips it so a
// `- [ ] **Title.** body` line reads the same as `- **Title.** body`.
const CHECKBOX_PREFIX_RE = /^\[[ xX~]\]\s+/;
// Permits single `*` inside the bold prefix (italics, glob patterns like
// `/queue/*`, `*.md`) by accepting any char that isn't `*`, OR a `*` not
// followed by another `*`. The lazy quantifier ensures we still stop at the
// first true `**` close.
const BOLD_PREFIX_RE = /^\*\*((?:[^*]|\*(?!\*))+?)\*\*\s*(.*)$/;
const ARCHIVE_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// A `blocked-by:` marker line inside an item body: optional sub-bullet
// marker, the key, then `;`-separated refs (titles legitimately contain
// commas, so `;` is the list separator). Detection runs on the MASKED line —
// a backticked mention (`` `blocked-by:` ``) blanks out and never matches —
// while refs are cut from the raw line so backticked spans inside a ref
// survive verbatim.
const BLOCKED_BY_RE = /^\s*(?:[-*+]\s+)?blocked-by:\s*(.+?)\s*$/i;

const CLOSE_REASON_RULES: Array<{re: RegExp; reason: CloseReason}> = [
  {re: /\bshipped\b|\bpublished\b|\breleased\b/i, reason: 'shipped'},
  {re: /\brejected\b|won['’]?t\s+(?:fix|do)\b|never\s+going\s+to\b/i, reason: 'rejected'},
  {re: /\bparked\b|\bon\s+hold\b|put\s+on\s+ice/i, reason: 'parked'},
  {
    re: /\bdeferred\s+(?:to|until|indefinitely)\b|absorbed\s+into|folded\s+into|moved\s+to\s+(?:the\s+)?[a-z-]+/i,
    reason: 'deferred'
  },
  {re: /\bcompleted\b|\bdone\b|\bfinished\b|\bclosed\b|\bfixed\b|\bresolved\b/i, reason: 'shipped'}
];

/**
 * Collapse hyphen variants (U+2010..U+2015) to ASCII `-`, lowercase, collapse
 * whitespace runs, trim. Used to make identity stable across cosmetic edits.
 */
export const normalizeTitle = (title: string): string =>
  title.toLowerCase().replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();

/** First-match-wins regex inference. Returns null when no rule matches. */
export const inferCloseReason = (body: string): CloseReason | null => {
  for (const {re, reason} of CLOSE_REASON_RULES) {
    if (re.test(body)) return reason;
  }
  return null;
};

const hashBody = (title: string, body: string): string =>
  createHash('sha256').update(title).update('\0').update(body).digest('hex');

interface PendingItem {
  startLine: number; // 1-based, in the full original content
  rawLines: string[]; // original (un-masked) lines, including the bullet line
  maskedLines: string[]; // code-masked twins, index-aligned with rawLines
}

interface ParseState {
  isArchive: boolean;
  section: QueueSection | null;
  priority: number;
  closedAt: string | null;
  positions: Map<string, number>;
  pending: PendingItem | null;
  items: ParsedQueueItem[];
}

const positionKey = (section: QueueSection, priority: number, closedAt: string | null): string =>
  `${section}\0${priority}\0${closedAt ?? ''}`;

const flushItem = (state: ParseState, project: string, sourceFile: string): void => {
  const pending = state.pending;
  state.pending = null;
  if (!pending || state.section === null) return;

  // Strip the bullet marker (and any legacy `[ ]`/`[x]`/`[~]` checkbox)
  // from the first line.
  const firstRaw = pending.rawLines[0] ?? '';
  const bulletMatch = TOP_BULLET_RE.exec(firstRaw);
  const afterBullet = bulletMatch ? (bulletMatch[1] ?? '') : firstRaw.trimStart();
  const firstAfterBullet = afterBullet.replace(CHECKBOX_PREFIX_RE, '');

  let title: string;
  let bodyHead: string;
  const boldMatch = BOLD_PREFIX_RE.exec(firstAfterBullet);
  if (boldMatch) {
    title = (boldMatch[1] ?? '').trim();
    bodyHead = (boldMatch[2] ?? '').trim();
  } else {
    title = firstAfterBullet.trim();
    bodyHead = '';
  }
  if (!title) return; // skip degenerate bullets with no content

  const continuation = pending.rawLines.slice(1).join('\n');
  const body = [bodyHead, continuation]
    .filter(s => s.length > 0)
    .join('\n')
    .replace(/\s+$/, '');

  // Marker lines are continuation lines only (index ≥ 1): the bullet line
  // carries the title, and an anchored match there would double-read a
  // degenerate no-bold item as its own blocker ref.
  const blockedBy: string[] = [];
  const seenRefs = new Set<string>();
  for (let i = 1; i < pending.rawLines.length; ++i) {
    if (!BLOCKED_BY_RE.test(pending.maskedLines[i] ?? '')) continue;
    const raw = BLOCKED_BY_RE.exec(pending.rawLines[i] ?? '');
    if (!raw) continue;
    for (const piece of (raw[1] ?? '').split(';')) {
      const ref = piece.trim();
      if (ref.length === 0) continue;
      const key = normalizeTitle(ref);
      if (seenRefs.has(key)) continue;
      seenRefs.add(key);
      blockedBy.push(ref);
    }
  }

  const key = positionKey(state.section, state.priority, state.closedAt);
  const nextPos = (state.positions.get(key) ?? 0) + 1;
  state.positions.set(key, nextPos);

  const isArchive = state.section === 'archive';
  state.items.push({
    project,
    section: state.section,
    priority: isArchive ? 0 : state.priority,
    position: nextPos,
    title,
    title_norm: normalizeTitle(title),
    body,
    closed_at: isArchive ? state.closedAt : null,
    close_reason: isArchive ? inferCloseReason(body) : null,
    source_file: sourceFile,
    source_line: pending.startLine,
    body_hash: hashBody(title, body),
    blocked_by: blockedBy
  });
};

const handleArchiveHeading = (state: ParseState, headingText: string): void => {
  state.section = 'archive';
  state.priority = 0;
  const m = ARCHIVE_DATE_RE.exec(headingText);
  state.closedAt = m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};

const handleQueueHeading = (state: ParseState, headingText: string): void => {
  const lc = headingText.toLowerCase();
  const mapped = SECTION_HEADINGS[lc];
  if (mapped) {
    state.section = mapped;
    state.priority = 0;
    state.closedAt = null;
  } else {
    // Unknown H2 (e.g. an intro section that someone added) — drop into a
    // null section so its content is ignored until the next recognized H2.
    state.section = null;
    state.priority = 0;
    state.closedAt = null;
  }
};

/**
 * Parse a project's queue.md or queue-archive.md content into structured items.
 *
 * @param project     project slug, e.g. `'node-re2'`
 * @param sourceFile  vault-relative path, e.g. `'projects/node-re2/queue.md'`
 * @param content     full file contents including frontmatter
 */
export const parseQueueFile = (
  project: string,
  sourceFile: string,
  content: string
): ParsedQueueItem[] => {
  const isArchive = sourceFile.endsWith('queue-archive.md');

  // Identify the line offset where the body starts so source_line stays
  // 1-based against the original file (not the FM-stripped body).
  const {body} = parseFrontmatter(content);
  const fmCharLen = content.length - body.length;
  const fmLineOffset = fmCharLen === 0 ? 0 : content.slice(0, fmCharLen).split('\n').length - 1;

  // Mask code regions for structural detection but keep the original lines
  // for body extraction so fenced examples land in `body` verbatim.
  const masked = maskCodeRegions(body);
  const maskedLines = masked.split('\n');
  const rawLines = body.split('\n');

  const state: ParseState = {
    isArchive,
    section: null,
    priority: 0,
    closedAt: null,
    positions: new Map(),
    pending: null,
    items: []
  };

  for (let i = 0; i < maskedLines.length; ++i) {
    const maskedLine = maskedLines[i] ?? '';
    const rawLine = rawLines[i] ?? '';
    const lineNumber = fmLineOffset + i + 1;

    const h2 = H2_RE.exec(maskedLine);
    if (h2) {
      flushItem(state, project, sourceFile);
      const headingText = (h2[1] ?? '').trim();
      if (isArchive) handleArchiveHeading(state, headingText);
      else handleQueueHeading(state, headingText);
      continue;
    }

    if (!isArchive) {
      const prio = PRIORITY_HEADING_RE.exec(maskedLine);
      if (prio) {
        flushItem(state, project, sourceFile);
        if (state.section === 'backlog') {
          state.priority = Number.parseInt(prio[1] ?? '0', 10);
        }
        continue;
      }
    }

    // Top-level bullet (no leading whitespace).
    if (/^[-*+]\s/.test(maskedLine)) {
      flushItem(state, project, sourceFile);
      if (state.section !== null) {
        state.pending = {startLine: lineNumber, rawLines: [rawLine], maskedLines: [maskedLine]};
      }
      continue;
    }

    // Continuation line — only consumed when we're inside an item.
    if (state.pending) {
      state.pending.rawLines.push(rawLine);
      state.pending.maskedLines.push(maskedLine);
    }
  }

  flushItem(state, project, sourceFile);
  return state.items;
};
