// A/B eval — does the agent.summary chunk-prefix help retrieval?
//
// Mode A (with-summary):  live DB chunks. Enriched records have summary
//                         prepended; unenriched records have body-only.
// Mode B (body-only):     for each enriched record, re-chunk body-only
//                         and re-embed via BGE. Unenriched chunks reused.
//
// Same metrics in both modes (P@5, R@10, NegDiscrim, threshold sweep) so
// the difference is purely the summary effect.
//
// Time budget: ~80 ms × ~10 chunks × 100 enriched records ≈ 80 s mode-B
// re-embedding. Eval itself is sub-second.
//
//   node eval/embedding-summary-ab.ts --db <vault.sqlite>

import {openDatabase} from '../src/db/connection.ts';
import {BgeEmbedder} from '../src/embeddings/bge.ts';
import {chunkBody} from '../src/embeddings/chunker.ts';

interface Args {
  db: string;
  samples: number;
  thresholds: number[];
}

const parseArgs = (argv: string[]): Args => {
  const args: Args = {db: '', samples: 1000, thresholds: [0.65, 0.70, 0.75, 0.80, 0.85, 0.90]};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') args.db = argv[++i] ?? '';
    else if (a === '--samples') args.samples = Number.parseInt(argv[++i] ?? '0', 10);
  }
  if (!args.db) {
    process.stderr.write('usage: embedding-summary-ab.ts --db <path> [--samples N]\n');
    process.exit(2);
  }
  return args;
};

interface RecordRow {
  id: string;
  path: string;
  body: string;
  agentSummary: string | null;
  chunks: Float32Array[];
}

const blobToFloat32 = (b: Uint8Array): Float32Array =>
  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

const cosine = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

const recordPairSim = (a: RecordRow, b: RecordRow): number => {
  let best = -Infinity;
  for (const x of a.chunks) for (const y of b.chunks) {
    const s = cosine(x, y);
    if (s > best) best = s;
  }
  return best;
};

const topKRecord = (q: RecordRow, all: RecordRow[], k: number): string[] => {
  const scored: {id: string; sim: number}[] = [];
  for (const r of all) {
    if (r.id === q.id) continue;
    scored.push({id: r.id, sim: recordPairSim(q, r)});
  }
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, k).map(s => s.id);
};

const precisionAtK = (records: RecordRow[], related: Map<string, Set<string>>, k: number): number => {
  let sum = 0, n = 0;
  for (const r of records) {
    const pos = related.get(r.id);
    if (!pos || pos.size === 0) continue;
    const near = topKRecord(r, records, k);
    sum += near.filter(id => pos.has(id)).length / k;
    n++;
  }
  return n ? sum / n : 0;
};

const recallAtK = (records: RecordRow[], related: Map<string, Set<string>>, k: number): number => {
  let sum = 0, n = 0;
  for (const r of records) {
    const pos = related.get(r.id);
    if (!pos || pos.size === 0) continue;
    const near = new Set(topKRecord(r, records, k));
    let hits = 0;
    for (const p of pos) if (near.has(p)) hits++;
    sum += hits / pos.size;
    n++;
  }
  return n ? sum / n : 0;
};

const negDiscrim = (
  records: RecordRow[],
  related: Map<string, Set<string>>,
  byId: Map<string, RecordRow>,
  samples: number
): number => {
  let rng = 0x9e3779b1;
  const rand = (): number => { rng = (rng * 1103515245 + 12345) >>> 0; return rng / 0x100000000; };
  const positives: Array<[string, string]> = [];
  for (const [from, tos] of related) for (const to of tos) positives.push([from, to]);
  if (positives.length === 0) return 0;
  let wins = 0, total = 0;
  for (let i = 0; i < samples; i++) {
    const [a, b] = positives[Math.floor(rand() * positives.length)]!;
    const ar = byId.get(a); const br = byId.get(b);
    if (!ar || !br) continue;
    let cr: RecordRow | undefined;
    for (let k = 0; k < 20; k++) {
      const c = records[Math.floor(rand() * records.length)]!;
      if (c.id === a || c.id === b) continue;
      if (related.get(a)?.has(c.id)) continue;
      cr = c; break;
    }
    if (!cr) continue;
    if (recordPairSim(ar, br) > recordPairSim(ar, cr)) wins++;
    total++;
  }
  return total ? wins / total : 0;
};

interface ThresholdRow {
  threshold: number;
  tp: number; fp: number; fn: number; tn: number;
  precision: number; recall: number; f1: number;
}

const sweep = (
  records: RecordRow[],
  related: Map<string, Set<string>>,
  thresholds: number[]
): ThresholdRow[] => {
  const pairs: {sim: number; positive: boolean}[] = [];
  for (let i = 0; i < records.length; i++)
    for (let j = i + 1; j < records.length; j++) {
      const a = records[i]!; const b = records[j]!;
      const sim = recordPairSim(a, b);
      const positive = !!(related.get(a.id)?.has(b.id) || related.get(b.id)?.has(a.id));
      pairs.push({sim, positive});
    }
  const fbeta = (p: number, r: number, beta: number): number => {
    if (p === 0 && r === 0) return 0;
    const b2 = beta * beta;
    return (1 + b2) * p * r / (b2 * p + r);
  };
  const out: ThresholdRow[] = [];
  for (const t of thresholds) {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const p of pairs) {
      if (p.sim >= t) p.positive ? tp++ : fp++;
      else p.positive ? fn++ : tn++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    out.push({threshold: t, tp, fp, fn, tn, precision, recall, f1: fbeta(precision, recall, 1)});
  }
  return out;
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const db = openDatabase({path: args.db});

  // Load records with bodies + agent_summary, and stored chunks.
  const recordRows = db.prepare(
    `SELECT record_id, file_path, body, agent_summary FROM records ORDER BY record_id`
  ).all() as Array<{record_id: string; file_path: string; body: string; agent_summary: string | null}>;

  const chunkRows = db.prepare(
    `SELECT record_id, chunk_index, embedding FROM record_vec ORDER BY record_id, chunk_index`
  ).all() as Array<{record_id: string; chunk_index: number | bigint; embedding: Uint8Array}>;

  const chunksById = new Map<string, Float32Array[]>();
  for (const c of chunkRows) {
    let arr = chunksById.get(c.record_id);
    if (!arr) { arr = []; chunksById.set(c.record_id, arr); }
    arr.push(blobToFloat32(c.embedding));
  }

  // Mode A: stored chunks (live DB state — enriched records have summary prefix).
  const modeA: RecordRow[] = recordRows.map(r => ({
    id: r.record_id,
    path: r.file_path,
    body: r.body,
    agentSummary: r.agent_summary,
    chunks: chunksById.get(r.record_id) ?? []
  })).filter(r => r.chunks.length > 0);

  process.stdout.write(`loaded ${modeA.length} records (${modeA.reduce((n, r) => n + r.chunks.length, 0)} chunks)\n`);

  const enriched = modeA.filter(r => r.agentSummary !== null);
  process.stdout.write(`enriched: ${enriched.length}\n`);

  // Mode B: re-embed body-only chunks for enriched records. Unenriched records'
  // chunks are already body-only and shared between modes.
  process.stdout.write(`re-embedding ${enriched.length} enriched records body-only…\n`);
  const t0 = performance.now();
  const embedder = new BgeEmbedder();
  const bodyOnlyChunks = new Map<string, Float32Array[]>();
  let totalReembedded = 0;
  for (const r of enriched) {
    const chunks = chunkBody(r.body); // no summary
    if (chunks.length === 0) {
      bodyOnlyChunks.set(r.id, []);
      continue;
    }
    const vecs = await embedder.embedBatch(chunks);
    bodyOnlyChunks.set(r.id, vecs);
    totalReembedded += chunks.length;
  }
  const dt = (performance.now() - t0) / 1000;
  process.stdout.write(`re-embedded ${totalReembedded} chunks in ${dt.toFixed(1)} s (${(totalReembedded / dt).toFixed(1)} chunks/s)\n`);

  const modeB: RecordRow[] = modeA.map(r => ({
    ...r,
    chunks: r.agentSummary !== null ? bodyOnlyChunks.get(r.id) ?? [] : r.chunks
  })).filter(r => r.chunks.length > 0);

  // Ground-truth: related-to edges (symmetric — we'll handle in metrics).
  const edges = db.prepare(
    `SELECT from_id AS f, to_id AS t FROM edges WHERE type = 'related-to'`
  ).all() as Array<{f: string; t: string}>;
  const related = new Map<string, Set<string>>();
  for (const {f, t} of edges) {
    if (!related.has(f)) related.set(f, new Set());
    related.get(f)!.add(t);
  }
  process.stdout.write(`related-to edges: ${edges.length}\n\n`);

  // --- run metrics on each mode ---------------------------------------------

  const run = (records: RecordRow[]): {
    p5: number; r10: number; nd: number; sweep: ThresholdRow[];
  } => {
    const byId = new Map(records.map(r => [r.id, r]));
    const p5 = precisionAtK(records, related, 5);
    const r10 = recallAtK(records, related, 10);
    const nd = negDiscrim(records, related, byId, args.samples);
    const sw = sweep(records, related, args.thresholds);
    return {p5, r10, nd, sweep: sw};
  };

  process.stdout.write('computing metrics for mode A (with-summary)…\n');
  const a = run(modeA);
  process.stdout.write('computing metrics for mode B (body-only)…\n');
  const b = run(modeB);

  // --- report ---------------------------------------------------------------

  const fmt = (n: number, d = 4): string => n.toFixed(d);
  const delta = (na: number, nb: number): string => {
    const diff = na - nb;
    const sign = diff >= 0 ? '+' : '';
    const pct = nb !== 0 ? ((diff / nb) * 100).toFixed(1) : 'inf';
    return `${sign}${diff.toFixed(4)} (${sign}${pct}%)`;
  };

  process.stdout.write('\n=== Aggregate metrics ===\n');
  process.stdout.write(`metric         A=with-summary   B=body-only      A − B (lift)\n`);
  process.stdout.write(`P@5            ${fmt(a.p5)}            ${fmt(b.p5)}            ${delta(a.p5, b.p5)}\n`);
  process.stdout.write(`R@10           ${fmt(a.r10)}            ${fmt(b.r10)}            ${delta(a.r10, b.r10)}\n`);
  process.stdout.write(`NegDiscrim     ${fmt(a.nd)}            ${fmt(b.nd)}            ${delta(a.nd, b.nd)}\n`);

  process.stdout.write('\n=== Per-threshold pair-level PR sweep ===\n');
  process.stdout.write('threshold | A precision | A recall | B precision | B recall | A.recall - B.recall\n');
  for (let i = 0; i < a.sweep.length; i++) {
    const ar = a.sweep[i]!; const br = b.sweep[i]!;
    process.stdout.write(
      `   ${ar.threshold.toFixed(2)}    |   ${fmt(ar.precision, 3)}    |  ${fmt(ar.recall, 3)}   |   ${fmt(br.precision, 3)}    |  ${fmt(br.recall, 3)}   |  ${delta(ar.recall, br.recall)}\n`
    );
  }

  process.stdout.write('\n=== Mode-A (with-summary) operating points ===\n');
  for (const r of a.sweep) {
    process.stdout.write(`  ${r.threshold.toFixed(2)} → P=${fmt(r.precision, 3)} R=${fmt(r.recall, 3)} F1=${fmt(r.f1, 3)}  TP=${r.tp} FP=${r.fp} FN=${r.fn}\n`);
  }
  process.stdout.write('\n=== Mode-B (body-only) operating points ===\n');
  for (const r of b.sweep) {
    process.stdout.write(`  ${r.threshold.toFixed(2)} → P=${fmt(r.precision, 3)} R=${fmt(r.recall, 3)} F1=${fmt(r.f1, 3)}  TP=${r.tp} FP=${r.fp} FN=${r.fn}\n`);
  }

  db.close();
};

await main();
