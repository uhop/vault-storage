// For each note, surface the top-N nearest neighbours by BGE-chunked
// retrieval that are NOT yet in its `related:` array (and not body-wikilinked
// from it). These become candidates for a human/agent review pass that
// densifies the curated `related:` ground truth — the eval's actual
// bottleneck is sparse curation, not the embedder.
//
//   node eval/propose-related.ts --db <vault.sqlite> --vault <root> \
//                                --output <candidates.tsv> [--per-note 10] [--limit 50]
//
// Output: TSV (record path, candidate path, distance, candidate-title) plus
// a markdown summary file alongside it for human review. The reviewing agent
// reads this and decides which candidates are genuine semantic matches; the
// accepted set is then written into the source notes' `related:` arrays.

import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {RecordVecRepository} from '../src/db/vec-repo.ts';
import {parseFrontmatter} from '../src/markdown/frontmatter.ts';
import {extractRelatedFromFrontmatter, extractWikilinks} from '../src/markdown/wikilinks.ts';
import {WikilinkResolver} from '../src/importer/resolver.ts';
import type {VaultRecord} from '../src/records/types.ts';

interface CliArgs {
  db: string;
  vault: string;
  output: string;
  perNote: number;
  limit: number;
}

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = {db: '', vault: '', output: 'eval/related-candidates.tsv', perNote: 10, limit: 0};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') args.db = argv[++i] ?? '';
    else if (a === '--vault') args.vault = argv[++i] ?? '';
    else if (a === '--output') args.output = argv[++i] ?? args.output;
    else if (a === '--per-note') args.perNote = Number.parseInt(argv[++i] ?? '10', 10);
    else if (a === '--limit') args.limit = Number.parseInt(argv[++i] ?? '0', 10);
  }
  if (!args.db || !args.vault) {
    process.stderr.write('usage: propose-related.ts --db <path> --vault <root> [--output <tsv>] [--per-note N] [--limit N]\n');
    process.exit(2);
  }
  return args;
};

const blobToFloat32 = (b: Uint8Array): Float32Array =>
  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

const args = parseArgs(process.argv.slice(2));
const dbPath = resolve(args.db);
const vaultRoot = resolve(args.vault);
const db = openDatabase({path: dbPath, readOnly: true});

interface Row {
  id: string;
  path: string;
  body: string;
  title: string;
}

// Pull all records with their bodies (chunks accessed via repo).
const rawRows = db.prepare('SELECT record_id, file_path, body FROM records').all() as Array<{
  record_id: string;
  file_path: string;
  body: string;
}>;

const rows: Row[] = rawRows.map(r => {
  let title = '';
  try {
    const src = readFileSync(`${vaultRoot}/${r.file_path}`, 'utf8');
    const fm = parseFrontmatter(src).data;
    title = typeof fm['title'] === 'string' ? fm['title'] : '';
  } catch {
    // file missing on disk; title stays empty
  }
  return {id: r.record_id, path: r.file_path, body: r.body, title};
});

const byId = new Map(rows.map(r => [r.id, r]));
const vaultRecords: VaultRecord[] = rows.map(r => ({
  recordId: r.id, filePath: r.path, parentPath: null, sequenceKey: null,
  type: 'permanent', body: r.body, contentHash: '', created: '', updated: '',
  lastReferenced: null, decayScore: 1, status: 'active', priority: 0, archivedAt: null
}));
const resolver = new WikilinkResolver(vaultRecords);

// Existing related/cites edges per source — exclude these from candidates.
const existingEdges = new Map<string, Set<string>>();
for (const e of db.prepare('SELECT from_id, to_id FROM edges').all() as Array<{from_id: string; to_id: string}>) {
  const set = existingEdges.get(e.from_id) ?? new Set();
  set.add(e.to_id);
  existingEdges.set(e.from_id, set);
}

// For each note, get top-(per-note × 3) chunk-level nearest, aggregate to
// records, drop self / already-related / already-cited, take top per-note.
const vecs = new RecordVecRepository(db);

interface Candidate {
  fromPath: string;
  toPath: string;
  toTitle: string;
  distance: number;
}
const candidates: Candidate[] = [];

const limit = args.limit > 0 ? args.limit : rows.length;

for (let i = 0; i < Math.min(limit, rows.length); i++) {
  const r = rows[i]!;
  // Re-parse the source to get this record's frontmatter `related:`,
  // since edges (`related-to`) only count what resolved at import time.
  let frontmatterRelated = new Set<string>();
  try {
    const src = readFileSync(`${vaultRoot}/${r.path}`, 'utf8');
    const fm = parseFrontmatter(src).data;
    for (const link of extractRelatedFromFrontmatter(fm)) {
      const id = resolver.resolve(link);
      if (id) frontmatterRelated.add(id);
    }
    for (const link of extractWikilinks(r.body)) {
      const id = resolver.resolve(link);
      if (id) frontmatterRelated.add(id); // body-cited too — already known
    }
  } catch {
    // proceed with edge-derived exclusions only
  }
  for (const id of existingEdges.get(r.id) ?? []) frontmatterRelated.add(id);

  // Use the record's own first chunk's vector as the query — fast,
  // and chunk 0 typically captures the title + leading content (which is
  // most representative of the note's identity).
  const v0Row = db.prepare(
    'SELECT embedding FROM record_vec WHERE record_id = ? AND chunk_index = 0'
  ).get(r.id) as {embedding: Uint8Array} | undefined;
  if (!v0Row) continue;
  const queryVec = blobToFloat32(v0Row.embedding);

  const nearest = vecs.nearest(queryVec, args.perNote * 3);
  let added = 0;
  for (const hit of nearest) {
    if (hit.recordId === r.id) continue;
    if (frontmatterRelated.has(hit.recordId)) continue;
    const target = byId.get(hit.recordId);
    if (!target) continue;
    candidates.push({fromPath: r.path, toPath: target.path, toTitle: target.title, distance: hit.distance});
    added++;
    if (added >= args.perNote) break;
  }
}

// Write TSV
const outPath = resolve(args.output);
mkdirSync(dirname(outPath), {recursive: true});
const tsvLines = ['from\tto\tdistance\ttitle'];
for (const c of candidates) {
  tsvLines.push(`${c.fromPath}\t${c.toPath}\t${c.distance.toFixed(4)}\t${c.toTitle.replace(/\t/g, ' ')}`);
}
writeFileSync(outPath, tsvLines.join('\n') + '\n', 'utf8');

// Also write a markdown review-friendly summary, grouped by source.
const mdPath = outPath.replace(/\.tsv$/, '.md');
const mdLines: string[] = [`# related-to candidates from BGE retrieval\n`];
mdLines.push(`Generated ${new Date().toISOString().slice(0, 10)} from \`${dbPath}\`. ${candidates.length} candidates across ${Math.min(limit, rows.length)} source notes (top-${args.perNote} each, excluding existing \`related:\` and body \`[[wikilinks]]\`).\n`);
mdLines.push('Distance interpretation: cosine distance (0 = identical, 2 = opposite). Candidates are sorted nearest-first per source.\n');

const grouped = new Map<string, Candidate[]>();
for (const c of candidates) {
  const list = grouped.get(c.fromPath) ?? [];
  list.push(c);
  grouped.set(c.fromPath, list);
}
for (const [from, list] of grouped) {
  mdLines.push(`## \`${from}\``);
  for (const c of list) {
    mdLines.push(`- ${c.distance.toFixed(3)}  →  \`${c.toPath}\`  *${c.toTitle}*`);
  }
  mdLines.push('');
}
writeFileSync(mdPath, mdLines.join('\n'), 'utf8');

process.stdout.write(`wrote ${outPath} and ${mdPath} (${candidates.length} candidates across ${grouped.size} source notes)\n`);

db.close();
