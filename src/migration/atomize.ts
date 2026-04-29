// Atomization splitter (one-shot, per design constraint C13).
//
// Transforms an oversized markdown file into a folder of piece files, one
// per top-level (`##`) section. The original file is deleted; a folder
// `_about.md` is left at the root with the source's title + tags.
//
// Round-trip fidelity is **not** a goal — output is canonical. Pieces are
// self-describing: each carries the inherited type/tags/status from the
// source so the standard importer reads them without folder-default magic.
//
// Atomization runs as a one-shot at migration time and as a maintenance
// trigger when a single file crosses 30 KB. Criteria:
//   - body bytes > 30,000 AND top-level sections > 5
//   - frontmatter `atomize: false` opts out (used for `_index.md` and similar
//     curated TOCs)

import {readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {parseFrontmatter, serializeFrontmatter} from '../markdown/frontmatter.ts';
import {typeFromPath} from '../importer/type-from-path.ts';
import {walkMarkdown} from '../importer/walk.ts';
import type {RecordType} from '../records/types.ts';

// Atomized pieces of legacy "running" project files inherit a more specific
// type than the source file's frontmatter. The live vault tags these files as
// `type: project`, but their pieces are individually decisions, learnings,
// queue items, etc. — and that's how the closed-enum type model expects them.
//
// Source-stem → piece-type mapping. Applied only when the source file lives
// directly under `projects/<name>/`. Files deeper in the tree (e.g.
// `projects/<name>/design/foo.md`) inherit by path via typeFromPath instead.
const PIECE_TYPE_BY_STEM: Record<string, RecordType> = {
  decisions: 'design',
  decision: 'design',
  learnings: 'research',
  learning: 'research',
  queue: 'queue-item',
  ideas: 'idea',
  idea: 'idea',
  bugs: 'bug-report',
  bug: 'bug-report',
  design: 'design',
  plan: 'plan',
  research: 'research'
};

const pieceTypeForSource = (relativePath: string): RecordType | null => {
  // Only override when the source is `projects/<name>/<stem>.md` — a "top-level"
  // running-file in a project folder. Deeper paths already get the right type
  // via typeFromPath when imported.
  const parts = relativePath.split('/');
  if (parts[0] !== 'projects' || parts.length !== 3) return null;
  const stem = basename(parts[2] ?? '', '.md');
  return PIECE_TYPE_BY_STEM[stem] ?? null;
};

export interface AtomizationDecision {
  atomize: boolean;
  reason: string;
}

export interface AtomizationOptions {
  /** Body byte threshold; files at or below stay whole. */
  byteThreshold?: number;
  /** Top-level section threshold; files with this many or fewer stay whole. */
  sectionThreshold?: number;
}

const DEFAULT_BYTE_THRESHOLD = 30_000;
const DEFAULT_SECTION_THRESHOLD = 5;

interface ParsedSection {
  /** Section heading without the leading `## ` prefix. */
  heading: string;
  /** Body of the section (everything until the next `## ` or EOF). */
  body: string;
}

const TOP_HEADING = /^##\s+(.+)$/gm;

/** Parse top-level (`## `) sections out of a markdown body. Returns an empty array if none. */
export const splitTopLevelSections = (body: string): ParsedSection[] => {
  const headings: Array<{at: number; len: number; text: string}> = [];
  for (const m of body.matchAll(TOP_HEADING)) {
    const at = m.index ?? 0;
    headings.push({at, len: m[0].length, text: m[1]?.trim() ?? ''});
  }
  if (headings.length === 0) return [];

  const sections: ParsedSection[] = [];
  for (let i = 0; i < headings.length; i++) {
    const cur = headings[i]!;
    const next = headings[i + 1];
    const sectionStart = cur.at + cur.len;
    const sectionEnd = next ? next.at : body.length;
    sections.push({
      heading: cur.text,
      body: body.slice(sectionStart, sectionEnd).replace(/^\n+/, '').replace(/\s+$/, '\n')
    });
  }
  return sections;
};

export const decideAtomization = (
  body: string,
  frontmatter: Record<string, unknown>,
  opts: AtomizationOptions = {}
): AtomizationDecision => {
  const byteThreshold = opts.byteThreshold ?? DEFAULT_BYTE_THRESHOLD;
  const sectionThreshold = opts.sectionThreshold ?? DEFAULT_SECTION_THRESHOLD;

  if (frontmatter['atomize'] === false) {
    return {atomize: false, reason: 'opt-out frontmatter atomize: false'};
  }

  const bytes = Buffer.byteLength(body, 'utf8');
  const sectionCount = splitTopLevelSections(body).length;
  if (bytes <= byteThreshold) {
    return {atomize: false, reason: `body ${bytes} bytes ≤ ${byteThreshold}`};
  }
  if (sectionCount <= sectionThreshold) {
    return {atomize: false, reason: `${sectionCount} sections ≤ ${sectionThreshold}`};
  }
  return {atomize: true, reason: `body ${bytes} bytes, ${sectionCount} sections`};
};

/** Slugify a heading into a filename stem: lowercase, kebab-case, ASCII-only, deduped. */
export const slugifyHeading = (heading: string): string =>
  heading
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

interface SplitInput {
  /** Vault-relative path (e.g., `projects/demo/decisions.md`). */
  relativePath: string;
  source: string;
}

export interface SplitOutputPiece {
  relativePath: string;
  content: string;
}

export interface SplitOutput {
  pieces: SplitOutputPiece[];
  about: SplitOutputPiece | null;
}

/**
 * Pure split: consume a source file, return the pieces + an `_about.md`. The
 * caller is responsible for writing them to disk and deleting the original.
 */
export const splitFile = (input: SplitInput): SplitOutput => {
  const {relativePath, source} = input;
  const {data, body} = parseFrontmatter(source);

  const sections = splitTopLevelSections(body);
  const stem = basename(relativePath, '.md');
  const folderRel = join(dirname(relativePath), stem);

  const inheritedKeys = ['tags', 'status', 'created'] as const;
  const inheritedFm: Record<string, unknown> = {};
  for (const key of inheritedKeys) {
    if (data[key] !== undefined) inheritedFm[key] = data[key];
  }

  // Type resolution priority for atomized pieces:
  //   1. PIECE_TYPE_BY_STEM map (top-level project running files —
  //      decisions/learnings/queue/etc).
  //   2. typeFromPath of the destination piece path, when it yields a specific
  //      sub-type (i.e., not the catch-all `project`/`permanent`). Example:
  //      `projects/<n>/design/foo.md` atomized into `projects/<n>/design/foo/`
  //      gives `design` from path; preferred over the source's explicit
  //      `type: project`.
  //   3. Inherited from the source's frontmatter `type:` value.
  const stemOverride = pieceTypeForSource(relativePath);
  let pieceType: unknown = stemOverride;
  if (pieceType === null) {
    // typeFromPath needs a representative piece path; pick a placeholder
    // filename that's not _about.md (which would yield `meta`).
    const samplePiecePath = join(dirname(relativePath), basename(relativePath, '.md'), 'piece.md');
    const pathInferred = typeFromPath(samplePiecePath);
    if (pathInferred !== 'project' && pathInferred !== 'permanent' && pathInferred !== 'meta') {
      pieceType = pathInferred;
    }
  }
  if (pieceType === null) pieceType = data['type'];

  const seenSlugs = new Map<string, number>();
  const pieces: SplitOutputPiece[] = sections.map((section, i) => {
    let slug = slugifyHeading(section.heading);
    if (slug.length === 0) slug = `section-${i + 1}`;
    const dupeCount = seenSlugs.get(slug) ?? 0;
    seenSlugs.set(slug, dupeCount + 1);
    const finalSlug = dupeCount === 0 ? slug : `${slug}-${dupeCount + 1}`;

    const pieceFm: Record<string, unknown> = {
      title: section.heading,
      ...(pieceType !== undefined && pieceType !== null ? {type: pieceType} : {}),
      ...inheritedFm,
      sequence_key: i + 1
    };
    const pieceBody = section.body.endsWith('\n') ? section.body : `${section.body}\n`;
    return {
      relativePath: join(folderRel, `${finalSlug}.md`),
      content: serializeFrontmatter({data: pieceFm, body: pieceBody})
    };
  });

  // The folder's _about.md captures the source-file-level title + any
  // user-authored frontmatter that doesn't belong on individual pieces
  // (description-y stuff). Lives at the folder root and reads as type=meta
  // via folder-default inference.
  const aboutFm: Record<string, unknown> = {
    title: typeof data['title'] === 'string' ? data['title'] : stem,
    type: 'meta',
    ...(data['tags'] !== undefined ? {tags: data['tags']} : {})
  };
  const aboutBody = `Atomized from \`${relativePath}\` on import. Pieces in this folder were generated from top-level \`##\` sections of the original file.\n`;
  const about: SplitOutputPiece = {
    relativePath: join(folderRel, '_about.md'),
    content: serializeFrontmatter({data: aboutFm, body: aboutBody})
  };

  return {pieces, about};
};

export interface AtomizeSummary {
  /** Files inspected. */
  total: number;
  /** Files actually split. */
  atomized: number;
  /** Files that met the size threshold but opted out via `atomize: false`. */
  optedOut: number;
  /** Pieces written across all atomized files. */
  piecesWritten: number;
  durationMs: number;
}

/**
 * Walk `targetDir`, identify atomization candidates, and split them in place.
 * Original files are deleted; pieces and `_about.md` written under a sibling
 * folder named after the original file's stem.
 */
export const atomizeVault = (
  targetDir: string,
  opts: AtomizationOptions = {}
): AtomizeSummary => {
  const start = performance.now();
  let total = 0;
  let atomized = 0;
  let optedOut = 0;
  let piecesWritten = 0;

  // Materialize the walker first since we mutate the tree (delete + create) mid-iteration.
  const files = [...walkMarkdown(targetDir)];

  for (const file of files) {
    total++;
    if (!existsSync(file.absolutePath)) continue; // could be a piece written under a folder we already produced
    const source = readFileSync(file.absolutePath, 'utf8');
    const parsed = parseFrontmatter(source);
    const decision = decideAtomization(parsed.body, parsed.data, opts);
    if (!decision.atomize) {
      if (parsed.data['atomize'] === false) optedOut++;
      continue;
    }

    const split = splitFile({relativePath: file.relativePath, source});
    for (const piece of split.pieces) {
      const abs = join(targetDir, piece.relativePath);
      mkdirSync(dirname(abs), {recursive: true});
      writeFileSync(abs, piece.content, 'utf8');
      piecesWritten++;
    }
    if (split.about) {
      const abs = join(targetDir, split.about.relativePath);
      mkdirSync(dirname(abs), {recursive: true});
      writeFileSync(abs, split.about.content, 'utf8');
    }
    unlinkSync(file.absolutePath);
    atomized++;
  }

  return {total, atomized, optedOut, piecesWritten, durationMs: Math.round(performance.now() - start)};
};
