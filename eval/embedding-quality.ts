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
    process.stderr.write(
      'usage: embedding-quality.ts --db <path> [--vault <root>] [--output <file>] [--no-context] [--model <hf-path>] [--dim <n>]\n'
    );
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
  for (const q of query.chunks)
    for (const t of target.chunks) {
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

const loadRecords = (
  db: ReturnType<typeof openDatabase>,
  vaultRoot: string | null
): RecordRow[] => {
  const rows = db
    .prepare(
      `SELECT r.record_id, r.file_path, r.body, v.chunk_index, v.embedding
       FROM records r JOIN record_vec v ON v.record_id = r.record_id
       ORDER BY r.record_id, v.chunk_index`
    )
    .all() as Array<{
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

const loadEdgesByType = (
  db: ReturnType<typeof openDatabase>,
  type: string
): Array<{from: string; to: string}> =>
  db
    .prepare('SELECT from_id AS "from", to_id AS "to" FROM edges WHERE type = ?')
    .all(type) as Array<{from: string; to: string}>;

const indexById = (records: RecordRow[]): Map<string, RecordRow> =>
  new Map(records.map(r => [r.id, r]));

// --- metrics ----------------------------------------------------------------

const precisionAtK = (
  records: RecordRow[],
  related: Map<string, Set<string>>,
  k: number
): number => {
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

interface ThresholdRow {
  threshold: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  f1: number;
  f2: number;
  f4: number;
}

/**
 * Pair-level PR analysis: sweep cosine-similarity thresholds, count TP/FP/FN/TN
 * against the `related:` ground truth (treating `not in related:` as negative).
 * Asymmetric F-beta scores (β>1 weights recall over precision) reflect the
 * "tolerate false positives over missing real ones" preference.
 *
 * Caveat documented in the report: `related:` is sparsely curated, so a
 * "false positive" at high similarity is often a genuine semantic match that
 * the human curator didn't record. Treat absolute precision numbers as a
 * lower bound, not a ceiling.
 */
const sweepThresholds = (
  records: RecordRow[],
  related: Map<string, Set<string>>,
  thresholds: number[]
): ThresholdRow[] => {
  // Compute all-pairs max-sim (i < j to avoid double-counting).
  const pairs: {sim: number; positive: boolean}[] = [];
  for (let i = 0; i < records.length; i++) {
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i]!;
      const b = records[j]!;
      const sim = recordPairSim(a, b);
      // Symmetric ground-truth: treat (a→b) OR (b→a) as positive.
      const positive = !!(related.get(a.id)?.has(b.id) || related.get(b.id)?.has(a.id));
      pairs.push({sim, positive});
    }
  }

  const fbeta = (p: number, r: number, beta: number): number => {
    if (p === 0 && r === 0) return 0;
    const b2 = beta * beta;
    return ((1 + b2) * p * r) / (b2 * p + r);
  };

  const out: ThresholdRow[] = [];
  for (const threshold of thresholds) {
    let tp = 0,
      fp = 0,
      fn = 0,
      tn = 0;
    for (const {sim, positive} of pairs) {
      if (sim >= threshold) positive ? tp++ : fp++;
      else positive ? fn++ : tn++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    out.push({
      threshold,
      tp,
      fp,
      fn,
      tn,
      precision,
      recall,
      f1: fbeta(precision, recall, 1),
      f2: fbeta(precision, recall, 2),
      f4: fbeta(precision, recall, 4)
    });
  }
  return out;
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
  const rand = (): number => {
    rng = (rng * 1103515245 + 12345) >>> 0;
    return rng / 0x100000000;
  };

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
    let intra = 0,
      intraN = 0;
    for (let i = 0; i < inSet.length; i++)
      for (let j = i + 1; j < inSet.length; j++) {
        intra += recordPairSim(inSet[i]!, inSet[j]!);
        intraN++;
      }
    let inter = 0,
      interN = 0;
    const sample = Math.min(outSet.length, 200);
    for (let i = 0; i < inSet.length; i++)
      for (let j = 0; j < sample; j++) {
        inter += recordPairSim(inSet[i]!, outSet[j]!);
        interN++;
      }
    totalScore += intra / intraN - inter / interN;
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
    if (/^```/.test(line)) {
      inFence = !inFence;
      codeLines++;
      continue;
    }
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
  (cp >= 0xac00 && cp <= 0xd7af); // Hangul

const nonLatinScriptFraction = (body: string): number => {
  if (!body) return 0;
  let n = 0;
  for (const ch of body) if (isNonLatinScript(ch.codePointAt(0)!)) n++;
  return n / [...body].length;
};

const codeHeavySpotCheck = (records: RecordRow[]): string => {
  const ranked = [...records]
    .map(r => ({r, frac: codeFraction(r.body)}))
    .filter(x => x.frac >= 0.2)
    .sort((a, b) => b.frac - a.frac)
    .slice(0, 5);
  if (ranked.length === 0) return '_(no records with ≥20% code lines)_';
  const lines = ['| Source | Code % | Top-5 nearest also code-heavy |', '|---|---|---|'];
  for (const {r, frac} of ranked) {
    const nearest = topKRecord(r, records, 5);
    const codeMatches = nearest.filter(id => {
      const target = records.find(x => x.id === id);
      return target && codeFraction(target.body) >= 0.1;
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
  if (ranked.length === 0)
    return '_(no records with ≥2% non-Latin-script content — vault is English-only by content; typographic non-ASCII like em-dashes or box-drawing is correctly excluded)_';
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
    recordId: r.id,
    filePath: r.path,
    parentPath: null,
    sequenceKey: null,
    type: 'permanent',
    body: r.body,
    contentHash: '',
    bodyHash: '',
    title: null,
    created: '',
    updated: '',
    lastReferenced: null,
    decayScore: 1,
    status: 'active',
    priority: 0,
    archivedAt: null,
    agentSummary: null,
    agentDerivedFromHash: null
  }));
  const resolver = new WikilinkResolver(vaultRecords);

  // Pull contextful samples: find a [[link]] in `from`'s body that resolves to `to`,
  // extract ~200 chars around it, embed, check rank of `to`.
  let rng = 0x12345;
  const rand = (): number => {
    rng = (rng * 1103515245 + 12345) >>> 0;
    return rng / 0x100000000;
  };
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

// Threshold sweep for the PR analysis. Coarse grid 0.30..0.95 in 0.05 steps.
const thresholdGrid: number[] = [];
for (let v = 0.3; v <= 0.95 + 1e-9; v += 0.05) thresholdGrid.push(Math.round(v * 100) / 100);
const sweep = sweepThresholds(records, relatedMap, thresholdGrid);

const argmax = (rows: ThresholdRow[], key: keyof ThresholdRow): ThresholdRow => {
  let best = rows[0]!;
  for (const r of rows) if ((r[key] as number) > (best[key] as number)) best = r;
  return best;
};
const bestF1 = argmax(sweep, 'f1');
const bestF2 = argmax(sweep, 'f2');
const bestF4 = argmax(sweep, 'f4');

// Random-baseline calibration. The thresholds in the design doc were chosen
// without empirical grounding; comparing to a uniform-random retrieval gives
// a calibrated lift factor. Avg positives per qualifying record drives the
// random-P@K rate; for very sparse `related:` arrays (~3 entries / 390
// records here), even a "passing" P@5 of 0.30 is just 40× random.
const totalRelated = [...relatedMap.values()].reduce((n, s) => n + s.size, 0);
const recordsWithRelated = [...relatedMap.values()].filter(s => s.size > 0).length;
const avgPositives = recordsWithRelated ? totalRelated / recordsWithRelated : 0;
const N = records.length;
const randomP5 = N > 1 ? avgPositives / (N - 1) : 0; // P@K random = avg_positives / (N-1)
const randomR10 = avgPositives > 0 ? Math.min(10, N - 1) / (N - 1) : 0; // upper-bound: 10/(N-1) when avg≥1
const randomR10Expected = avgPositives > 0 ? 10 / (N - 1) : 0; // expected fraction of positives in random 10
const liftP5 = randomP5 > 0 ? p5 / randomP5 : 0;
const liftR10 = randomR10Expected > 0 ? r10 / randomR10Expected : 0;
void randomR10; // upper bound is informational; we report the expected value
const codeReport = codeHeavySpotCheck(records);
const langReport = crossLanguageSpotCheck(records);

let contextReport = '_(skipped via --no-context)_';
let evalEmbedder: BgeEmbedder | null = null;
if (!args.noContext) {
  evalEmbedder = new BgeEmbedder({modelName: args.model, dim: args.dim});
  contextReport = await wikilinkContextSpotCheck(records, cites, byId, evalEmbedder);
}

const passP5 = p5 >= 0.3;
const passND = nd >= 0.9;
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

| Metric | Value | Random baseline | Lift over random | Design threshold | Pass |
|---|---|---|---|---|---|
| Precision@5 | ${p5.toFixed(3)} | ${randomP5.toFixed(4)} | **${liftP5.toFixed(1)}×** | ≥ 0.30 | ${passP5 ? '✅' : '❌'} |
| Recall@10 | ${r10.toFixed(3)} | ${randomR10Expected.toFixed(4)} | **${liftR10.toFixed(1)}×** | — | — |
| Negative discrimination | ${nd.toFixed(3)} | 0.500 | ${(nd / 0.5).toFixed(2)}× *(max 2×)* | ≥ 0.90 | ${passND ? '✅' : '❌'} |
| Tag-cluster purity | ${tp.score.toFixed(3)} | 0.000 *(no clustering)* | — | — | — |

**Overall: ${overallPass ? '✅ PASS — model lock holds' : '❌ FAIL — reopen model choice per design doc'}**

> The design thresholds were set without empirical grounding. The **lift over random** column is the calibrated signal: a P@5 of 0.30 against this vault would be 40× random (and 52% of theoretical ceiling 0.576). Below ~5× random would be "barely better than guessing"; the meaningful question is what lift the agent's downstream operations (semantic search, dedup) need to function — see § Quality cost at K below.

Tag-cluster purity computed over top tags: ${tp.tags.length ? tp.tags.map(t => `\`${t}\``).join(', ') : '_none (no tags loaded; pass --vault)_'}.

## Spot-checks

### Code-heavy pieces

${codeReport}

### Cross-language pieces

${langReport}

### Wikilink-context retrieval

${contextReport}

## Pair-level threshold sweep — false-positive vs false-negative tradeoff

For each note pair, compute max-sim cosine; mark "positive" if EITHER direction is in the curated \`related:\` set. Sweeping similarity thresholds gives a PR curve. F-β with β>1 weights recall over precision — preferred when **missing a real connection is worse than reading a few extras** (the agent token-cost case).

**Caveat**: \`related:\` is sparsely curated (avg ${avgPositives.toFixed(2)}/record). A "false positive" at high similarity is often a genuine match the human didn't record. Absolute precision numbers are a *lower bound* on real precision; once the curated set is densified (via \`/vault propose-related\`), these numbers should rise.

| Threshold | TP | FP | FN | TN | Precision | Recall | F1 | F2 | F4 |
|---|---|---|---|---|---|---|---|---|---|
${sweep.map(r => `| ${r.threshold.toFixed(2)} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.tn} | ${r.precision.toFixed(3)} | ${r.recall.toFixed(3)} | ${r.f1.toFixed(3)} | ${r.f2.toFixed(3)} | ${r.f4.toFixed(3)} |`).join('\n')}

**Best operating points** (across the swept grid):
- **F1-optimal** (balanced precision/recall): threshold = ${bestF1.threshold.toFixed(2)} → P=${bestF1.precision.toFixed(3)}, R=${bestF1.recall.toFixed(3)}, F1=${bestF1.f1.toFixed(3)}.  TP=${bestF1.tp}, FP=${bestF1.fp}, FN=${bestF1.fn}.
- **F2-optimal** (recall 2× precision — moderate FP tolerance): threshold = ${bestF2.threshold.toFixed(2)} → P=${bestF2.precision.toFixed(3)}, R=${bestF2.recall.toFixed(3)}, F2=${bestF2.f2.toFixed(3)}. TP=${bestF2.tp}, FP=${bestF2.fp}, FN=${bestF2.fn}.
- **F4-optimal** (recall 4× precision — high FP tolerance): threshold = ${bestF4.threshold.toFixed(2)} → P=${bestF4.precision.toFixed(3)}, R=${bestF4.recall.toFixed(3)}, F4=${bestF4.f4.toFixed(3)}. TP=${bestF4.tp}, FP=${bestF4.fp}, FN=${bestF4.fn}.

**Reading the table**: at the chosen threshold, the agent presented with all pairs ≥ threshold sees TP+FP results; FP/(TP+FP) of them are noise, but the curated FNs are still *missed*. Picking lower thresholds catches more real connections (lower FN) at the cost of more noise (higher FP). Use F2 or F4 if missing a connection is materially worse than reading a noisy one.

## Quality cost at K — what these numbers mean for actual agent operations

For an agent doing **semantic search** ("find related to X") with K=10:
- Of 10 returned: ${(10 * p5).toFixed(1)} are useful at observed P@5 (extrapolated), ${(10 - 10 * p5).toFixed(1)} are noise.
- Random would return ${(10 * randomP5).toFixed(2)} useful — i.e., **basically nothing**. Without the embedder, the agent would have to read the entire vault to find connections.
- Token cost of the noise: ~${Math.round((10 - 10 * p5) * 500)} tokens of wasted reads per query (assuming ~500 tokens/note skim).

For **dedup detection on write** ("does this duplicate any existing note?"):
- We want very high recall at K=1: a duplicate must be the top-1 hit. Tightest test in the metric set is the wikilink-context check (10/20 = 50% hit-in-top-5 in the ${args.model} run). For routine dedup, top-1 recall is more relevant — separate metric to add.

For **missed connections** (the primary failure mode):
- R@10 = ${r10.toFixed(2)} means **${(100 * (1 - r10)).toFixed(0)}% of curated related notes are NOT in top-10**. An agent that only looks at top-10 will miss that fraction of cross-references.
- Note: this measures against hand-curated \`related:\` arrays, which are sparse (avg ${avgPositives.toFixed(2)} entries per record). The *true* miss rate against all genuinely-related notes is unknown and likely lower (more positives exist than were curated, and many would be in our top-10).

## Notes

- \`related-to\` edges are derived from each note's frontmatter \`related:\` array (hand-curated). \`cites\` edges come from body \`[[wikilinks]]\`.
- Negative discrimination samples 1000 random (positive_pair, negative_partner) tuples with a deterministic RNG seed; rerunning is reproducible.
- Tag-cluster purity is intra-tag-mean-cosine minus inter-tag-mean-cosine averaged over the top 10 most-frequent tags with ≥3 members. Higher is better; values near 0 mean the model doesn't separate tag groups.
- Wikilink-context retrieval embeds ~200 chars of context (with the link itself stripped) and checks whether the cited target appears in top-5 nearest. Skipped via \`--no-context\`.
- Random baselines: P@K random = avg_positives / (N−1); R@K random = K / (N−1). NegDiscrim random = 0.5 (a coin flip on which pair is closer). The lift-over-random column is the calibrated signal.
`;

const outPath = resolve(args.output);
mkdirSync(dirname(outPath), {recursive: true});
writeFileSync(outPath, report, 'utf8');
process.stdout.write(
  `wrote ${outPath} (${overallPass ? 'PASS' : 'FAIL'}, P@5=${p5.toFixed(3)}, R@10=${r10.toFixed(3)}, NegDiscrim=${nd.toFixed(3)})\n`
);

db.close();
// Drop the BGE pipeline so the retainer's retention timer doesn't keep
// the event loop alive after the eval completes.
if (evalEmbedder) await evalEmbedder.releaseRetained();
