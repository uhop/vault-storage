// Embedding quality eval — produces a baseline report against an imported vault.
//
//   node eval/embedding-quality.ts --db <vault.sqlite> [--vault <root>] [--output <file>]
//
// Metrics:
//   - Precision@5    against `related-to` edges (frontmatter `related:`)
//   - Recall@10      against `related-to` edges
//   - NegDiscrim     positive (cited) vs random pair ordering
//   - TagPurity      mean intra-tag cosine minus mean inter-tag cosine, top-K tags
//
// Spot-checks: code-heavy, cross-language, wikilink-context retrieval.
//
// Gating per [[projects/vault-storage/design/embedding-model]] § Evaluation plan:
//   P@5 < 0.30 OR NegDiscrim < 0.90  →  reopen the BGE-small lock.

import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {BgeEmbedder} from '../src/embeddings/bge.ts';
import {parseFrontmatter} from '../src/markdown/frontmatter.ts';
import {WikilinkResolver} from '../src/importer/resolver.ts';
import type {VaultRecord} from '../src/records/types.ts';

interface RecordRow {
  id: string;
  path: string;
  body: string;
  /** One vector per chunk; record-pair similarity is max over chunk pairs. */
  chunks: Float32Array[];
  tags: string[];
}

interface CliArgs {
  db: string;
  vault: string | null;
  output: string;
  noContext: boolean;
  model: string;
  dim: number;
}

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = {
    db: '',
    vault: null,
    output: 'eval/baseline.md',
    noContext: false,
    model: 'Xenova/bge-small-en-v1.5',
    dim: 384
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') args.db = argv[++i] ?? '';
    else if (a === '--vault') args.vault = argv[++i] ?? null;
    else if (a === '--output') args.output = argv[++i] ?? args.output;
    else if (a === '--no-context') args.noContext = true;
    else if (a === '--model') args.model = argv[++i] ?? args.model;
    else if (a === '--dim') args.dim = Number.parseInt(argv[++i] ?? '0', 10);
  }
  if (!args.db) {
    process.stderr.write('usage: embedding-quality.ts --db <path> [--vault <root>] [--output <file>] [--no-context] [--model <hf-path>] [--dim <n>]\n');
    process.exit(2);
  }
  return args;
};

const blobToFloat32 = (b: Uint8Array): Float32Array =>
  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

const cosine = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s; // vectors are L2-normalized → dot product == cosine similarity
};

/** Max-sim between any chunk of `query` and any chunk of `target`. */
const recordPairSim = (query: RecordRow, target: RecordRow): number => {
  let best = -Infinity;
  for (const q of query.chunks) for (const t of target.chunks) {
    const s = cosine(q, t);
    if (s > best) best = s;
  }
  return best;
};

/** Max-sim between a single query vector and any chunk of `target`. */
const queryRecordSim = (query: Float32Array, target: RecordRow): number => {
  let best = -Infinity;
  for (const t of target.chunks) {
    const s = cosine(query, t);
    if (s > best) best = s;
  }
  return best;
};

const topK = (queryId: string, queryVec: Float32Array, all: RecordRow[], k: number): string[] => {
  const scored: {id: string; sim: number}[] = [];
  for (const r of all) {
    if (r.id === queryId) continue;
    scored.push({id: r.id, sim: queryRecordSim(queryVec, r)});
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, k).map(s => s.id);
};

const topKRecord = (query: RecordRow, all: RecordRow[], k: number): string[] => {
  const scored: {id: string; sim: number}[] = [];
  for (const r of all) {
    if (r.id === query.id) continue;
    scored.push({id: r.id, sim: recordPairSim(query, r)});
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, k).map(s => s.id);
};

const loadRecords = (db: ReturnType<typeof openDatabase>, vaultRoot: string | null): RecordRow[] => {
  const rows = db.prepare(
    `SELECT r.record_id, r.file_path, r.body, v.chunk_index, v.embedding
       FROM records r JOIN record_vec v ON v.record_id = r.record_id
       ORDER BY r.record_id, v.chunk_index`
  ).all() as Array<{
    record_id: string;
    file_path: string;
    body: string;
    chunk_index: number | bigint;
    embedding: Uint8Array;
  }>;

  // Group rows by record_id; chunks are already in chunk_index order.
  const byId = new Map<string, RecordRow>();
  for (const row of rows) {
    let rec = byId.get(row.record_id);
    if (!rec) {
      let tags: string[] = [];
      if (vaultRoot) {
        try {
          const src = readFileSync(`${vaultRoot}/${row.file_path}`, 'utf8');
          const fm = parseFrontmatter(src).data;
          const t = fm['tags'];
          if (Array.isArray(t)) tags = t.filter((x): x is string => typeof x === 'string');
        } catch {
          // file missing on disk; tags stay empty
        }
      }
      rec = {id: row.record_id, path: row.file_path, body: row.body, chunks: [], tags};
      byId.set(row.record_id, rec);
    }
    rec.chunks.push(blobToFloat32(row.embedding));
  }
  return [...byId.values()];
};

const loadEdgesByType = (db: ReturnType<typeof openDatabase>, type: string): Array<{from: string; to: string}> =>
  db.prepare('SELECT from_id AS "from", to_id AS "to" FROM edges WHERE type = ?').all(type) as Array<{from: string; to: string}>;

const indexById = (records: RecordRow[]): Map<string, RecordRow> =>
  new Map(records.map(r => [r.id, r]));

// --- metrics ----------------------------------------------------------------

const precisionAtK = (records: RecordRow[], related: Map<string, Set<string>>, k: number): number => {
  let sumPrecision = 0;
  let counted = 0;
  for (const r of records) {
    const positives = related.get(r.id);
    if (!positives || positives.size === 0) continue;
    const nearest = topKRecord(r, records, k);
    const hits = nearest.filter(id => positives.has(id)).length;
    sumPrecision += hits / k;
    counted++;
  }
  return counted ? sumPrecision / counted : 0;
};

const recallAtK = (records: RecordRow[], related: Map<string, Set<string>>, k: number): number => {
  let sumRecall = 0;
  let counted = 0;
  for (const r of records) {
    const positives = related.get(r.id);
    if (!positives || positives.size === 0) continue;
    const nearest = new Set(topKRecord(r, records, k));
    let hits = 0;
    for (const p of positives) if (nearest.has(p)) hits++;
    sumRecall += hits / positives.size;
    counted++;
  }
  return counted ? sumRecall / counted : 0;
};

const negDiscrim = (
  records: RecordRow[],
  related: Map<string, Set<string>>,
  byId: Map<string, RecordRow>,
  samples: number
): number => {
  // For each positive pair, draw a random non-positive partner; count how often
  // the positive pair has higher similarity. Deterministic seed for reproducibility.
  let rng = 0x9e3779b1;
  const rand = (): number => { rng = (rng * 1103515245 + 12345) >>> 0; return rng / 0x100000000; };

  const positives: Array<[string, string]> = [];
  for (const [from, tos] of related) for (const to of tos) positives.push([from, to]);
  if (positives.length === 0) return 0;

  let wins = 0;
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const [a, b] = positives[Math.floor(rand() * positives.length)]!;
    const ar = byId.get(a);
    const br = byId.get(b);
    if (!ar || !br) continue;
    let cr: RecordRow | undefined;
    for (let attempt = 0; attempt < 20; attempt++) {
      const cand = records[Math.floor(rand() * records.length)]!;
      if (cand.id === a || cand.id === b) continue;
      if (related.get(a)?.has(cand.id)) continue;
      cr = cand;
      break;
    }
    if (!cr) continue;
    const posSim = recordPairSim(ar, br);
    const negSim = recordPairSim(ar, cr);
    if (posSim > negSim) wins++;
    total++;
  }
  return total ? wins / total : 0;
};

const tagPurity = (records: RecordRow[], topTagCount: number): {score: number; tags: string[]} => {
  // For each of the top-K tags, mean cosine among records carrying that tag
  // minus mean cosine vs records NOT carrying it. Score = mean across tags.
  const tagCounts = new Map<string, number>();
  for (const r of records) for (const t of r.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  const top = [...tagCounts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topTagCount)
    .map(([t]) => t);

  if (top.length === 0) return {score: 0, tags: []};

  let totalScore = 0;
  for (const tag of top) {
    const inSet = records.filter(r => r.tags.includes(tag));
    const outSet = records.filter(r => !r.tags.includes(tag));
    if (inSet.length < 2 || outSet.length < 1) continue;
    let intra = 0, intraN = 0;
    for (let i = 0; i < inSet.length; i++)
      for (let j = i + 1; j < inSet.length; j++) {
        intra += recordPairSim(inSet[i]!, inSet[j]!);
        intraN++;
      }
    let inter = 0, interN = 0;
    const sample = Math.min(outSet.length, 200);
    for (let i = 0; i < inSet.length; i++)
      for (let j = 0; j < sample; j++) {
        inter += recordPairSim(inSet[i]!, outSet[j]!);
        interN++;
      }
    totalScore += (intra / intraN) - (inter / interN);
  }
  return {score: totalScore / top.length, tags: top};
};

// --- spot-checks ------------------------------------------------------------

const codeFraction = (body: string): number => {
  const lines = body.split('\n');
  if (lines.length === 0) return 0;
  let inFence = false;
  let codeLines = 0;
  for (const line of lines) {
    if (/^```/.test(line)) { inFence = !inFence; codeLines++; continue; }
    if (inFence || /^( {4,}|\t)/.test(line)) codeLines++;
  }
  return codeLines / lines.length;
};

// Non-Latin script ranges: Cyrillic, Greek, Hebrew, Arabic, Devanagari,
// Hiragana, Katakana, CJK unified, Hangul. Excludes Latin punctuation
// (U+2000-block em-dashes, curly quotes) and box-drawing graphics (U+2500
// block) so an English note with rich typography or terminal output doesn't
// misread as foreign-language content.
const isNonLatinScript = (cp: number): boolean =>
  (cp >= 0x0370 && cp <= 0x03ff) || // Greek
  (cp >= 0x0400 && cp <= 0x052f) || // Cyrillic + Supplement
  (cp >= 0x0590 && cp <= 0x05ff) || // Hebrew
  (cp >= 0x0600 && cp <= 0x06ff) || // Arabic
  (cp >= 0x0900 && cp <= 0x097f) || // Devanagari
  (cp >= 0x3040 && cp <= 0x309f) || // Hiragana
  (cp >= 0x30a0 && cp <= 0x30ff) || // Katakana
  (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
  (cp >= 0xac00 && cp <= 0xd7af);   // Hangul

const nonLatinScriptFraction = (body: string): number => {
  if (!body) return 0;
  let n = 0;
  for (const ch of body) if (isNonLatinScript(ch.codePointAt(0)!)) n++;
  return n / [...body].length;
};

const codeHeavySpotCheck = (records: RecordRow[]): string => {
  const ranked = [...records]
    .map(r => ({r, frac: codeFraction(r.body)}))
    .filter(x => x.frac >= 0.20)
    .sort((a, b) => b.frac - a.frac)
    .slice(0, 5);
  if (ranked.length === 0) return '_(no records with ≥20% code lines)_';
  const lines = ['| Source | Code % | Top-5 nearest also code-heavy |', '|---|---|---|'];
  for (const {r, frac} of ranked) {
    const nearest = topKRecord(r, records, 5);
    const codeMatches = nearest.filter(id => {
      const target = records.find(x => x.id === id);
      return target && codeFraction(target.body) >= 0.10;
    }).length;
    lines.push(`| \`${r.path}\` | ${(frac * 100).toFixed(0)}% | ${codeMatches}/5 |`);
  }
  return lines.join('\n');
};

const crossLanguageSpotCheck = (records: RecordRow[]): string => {
  const ranked = records
    .map(r => ({r, frac: nonLatinScriptFraction(r.body)}))
    .filter(x => x.frac >= 0.02)
    .sort((a, b) => b.frac - a.frac)
    .slice(0, 5);
  if (ranked.length === 0) return '_(no records with ≥2% non-Latin-script content — vault is English-only by content; typographic non-ASCII like em-dashes or box-drawing is correctly excluded)_';
  const lines = ['| Source | Non-Latin-script % | Top-3 nearest paths |', '|---|---|---|'];
  for (const {r, frac} of ranked) {
    const nearest = topKRecord(r, records, 3);
    const paths = nearest
      .map(id => records.find(x => x.id === id)?.path ?? '?')
      .map(p => `\`${p}\``)
      .join(', ');
    lines.push(`| \`${r.path}\` | ${(frac * 100).toFixed(1)}% | ${paths} |`);
  }
  return lines.join('\n');
};

const wikilinkContextSpotCheck = async (
  records: RecordRow[],
  cites: Array<{from: string; to: string}>,
  byId: Map<string, RecordRow>,
  embedder: BgeEmbedder
): Promise<string> => {
  const vaultRecords: VaultRecord[] = records.map(r => ({
    recordId: r.id, filePath: r.path, parentPath: null, sequenceKey: null,
    type: 'permanent', body: r.body, contentHash: '', created: '', updated: '',
    lastReferenced: null, decayScore: 1, status: 'active', priority: 0, archivedAt: null
  }));
  const resolver = new WikilinkResolver(vaultRecords);

  // Pull contextful samples: find a [[link]] in `from`'s body that resolves to `to`,
  // extract ~200 chars around it, embed, check rank of `to`.
  let rng = 0x12345;
  const rand = (): number => { rng = (rng * 1103515245 + 12345) >>> 0; return rng / 0x100000000; };
  const shuffled = [...cites].sort(() => rand() - 0.5).slice(0, 60); // oversample, take first 20 with usable context

  const samples: Array<{from: string; to: string; context: string}> = [];
  for (const c of shuffled) {
    if (samples.length >= 20) break;
    const src = byId.get(c.from);
    if (!src) continue;
    const re = /\[\[([^\]\n|[]+?)(?:\|[^\]]*)?\]\]/g;
    for (const m of src.body.matchAll(re)) {
      const target = m[1]?.trim();
      if (!target) continue;
      if (resolver.resolve(target) !== c.to) continue;
      const idx = m.index ?? 0;
      const start = Math.max(0, idx - 100);
      const end = Math.min(src.body.length, idx + (m[0]?.length ?? 0) + 100);
      const context = src.body.slice(start, end).replace(re, ''); // strip links so the model embeds context, not the link itself
      samples.push({from: c.from, to: c.to, context});
      break;
    }
  }
  if (samples.length === 0) return '_(no usable wikilink context samples)_';

  const queryVecs = await embedder.embedBatch(samples.map(s => s.context));
  let hits = 0;
  for (let i = 0; i < samples.length; i++) {
    const ranked = topK(samples[i]!.from, queryVecs[i]!, records, 5);
    if (ranked.includes(samples[i]!.to)) hits++;
  }
  return `${hits}/${samples.length} wikilink contexts retrieved their cited target in top-5.`;
};

// --- main -------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const dbPath = resolve(args.db);
const db = openDatabase({path: dbPath});

const records = loadRecords(db, args.vault ? resolve(args.vault) : null);
if (records.length === 0) {
  process.stderr.write('no records with embeddings found — run import first\n');
  process.exit(1);
}

const byId = indexById(records);
const relatedRaw = loadEdgesByType(db, 'related-to');
const cites = loadEdgesByType(db, 'cites');

const relatedMap = new Map<string, Set<string>>();
for (const e of relatedRaw) {
  const set = relatedMap.get(e.from) ?? new Set();
  set.add(e.to);
  relatedMap.set(e.from, set);
}

const t0 = performance.now();
const p5 = precisionAtK(records, relatedMap, 5);
const r10 = recallAtK(records, relatedMap, 10);
const nd = negDiscrim(records, relatedMap, byId, 1000);
const tp = tagPurity(records, 10);
const codeReport = codeHeavySpotCheck(records);
const langReport = crossLanguageSpotCheck(records);

let contextReport = '_(skipped via --no-context)_';
if (!args.noContext) {
  const embedder = new BgeEmbedder({modelName: args.model, dim: args.dim});
  contextReport = await wikilinkContextSpotCheck(records, cites, byId, embedder);
}

const passP5 = p5 >= 0.30;
const passND = nd >= 0.90;
const overallPass = passP5 && passND;
const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

const report = `# Embedding quality baseline

- Date: ${new Date().toISOString().slice(0, 10)}
- DB: \`${dbPath}\`
- Records: ${records.length}
- Total chunks: ${records.reduce((n, r) => n + r.chunks.length, 0)} (avg ${(records.reduce((n, r) => n + r.chunks.length, 0) / records.length).toFixed(2)} per record)
- Model: \`${args.model}\` (${args.dim}-dim float32)
- Records with at least one \`related-to\` edge: ${[...relatedMap.values()].filter(s => s.size > 0).length}
- Total \`related-to\` edges: ${relatedRaw.length}
- Total \`cites\` edges: ${cites.length}
- Eval runtime: ${elapsed}s

## Aggregate metrics

| Metric | Value | Threshold | Pass |
|---|---|---|---|
| Precision@5 | ${p5.toFixed(3)} | ≥ 0.30 | ${passP5 ? '✅' : '❌'} |
| Recall@10 | ${r10.toFixed(3)} | — | — |
| Negative discrimination | ${nd.toFixed(3)} | ≥ 0.90 | ${passND ? '✅' : '❌'} |
| Tag-cluster purity | ${tp.score.toFixed(3)} | — | — |

**Overall: ${overallPass ? '✅ PASS — model lock holds' : '❌ FAIL — reopen model choice per design doc'}**

Tag-cluster purity computed over top tags: ${tp.tags.length ? tp.tags.map(t => `\`${t}\``).join(', ') : '_none (no tags loaded; pass --vault)_'}.

## Spot-checks

### Code-heavy pieces

${codeReport}

### Cross-language pieces

${langReport}

### Wikilink-context retrieval

${contextReport}

## Notes

- \`related-to\` edges are derived from each note's frontmatter \`related:\` array (hand-curated). \`cites\` edges come from body \`[[wikilinks]]\`.
- Negative discrimination samples 1000 random (positive_pair, negative_partner) tuples with a deterministic RNG seed; rerunning is reproducible.
- Tag-cluster purity is intra-tag-mean-cosine minus inter-tag-mean-cosine averaged over the top 10 most-frequent tags with ≥3 members. Higher is better; values near 0 mean the model doesn't separate tag groups.
- Wikilink-context retrieval embeds ~200 chars of context (with the link itself stripped) and checks whether the cited target appears in top-5 nearest. Skipped via \`--no-context\`.
`;

const outPath = resolve(args.output);
mkdirSync(dirname(outPath), {recursive: true});
writeFileSync(outPath, report, 'utf8');
process.stdout.write(`wrote ${outPath} (${overallPass ? 'PASS' : 'FAIL'}, P@5=${p5.toFixed(3)}, R@10=${r10.toFixed(3)}, NegDiscrim=${nd.toFixed(3)})\n`);

db.close();
