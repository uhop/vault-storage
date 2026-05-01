// Query-document A/B eval — does the agent.summary chunker prefix help
// retrieval against short, paraphrastic queries?
//
// This is the *right* test shape for HyDE-style index-time augmentation.
// The 2026-05-01 document-document A/B (eval/embedding-summary-ab.ts) was
// a null because both sides of the comparison were full documents — the
// query-shape advantage of summary anchors only fires when the query is
// short relative to the document.
//
//   node eval/embedding-summary-query-ab.ts --db <vault.sqlite>
//
// Method:
//   1. Hand-curated query → target_path pairs over the 30 enriched topic
//      notes that were varied across the wave-1, wave-2, and main-session
//      enrichment runs.
//   2. Mode A: live DB chunks (target's chunks include summary prefix).
//   3. Mode B: re-embed enriched records' chunks body-only.
//   4. For each query in each mode: embed, score vs all chunks, rank
//      target's best chunk among the 5052-chunk corpus.
//   5. Report top-1, top-5, top-10 hit rate; MRR; mean rank.

import {openDatabase} from '../src/db/connection.ts';
import {BgeEmbedder} from '../src/embeddings/bge.ts';
import {chunkBody} from '../src/embeddings/chunker.ts';

interface Args { db: string; }
const parseArgs = (argv: string[]): Args => {
  const args: Args = {db: ''};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') args.db = argv[++i] ?? '';
  }
  if (!args.db) {
    process.stderr.write('usage: embedding-summary-query-ab.ts --db <path>\n');
    process.exit(2);
  }
  return args;
};

interface Chunk {
  recordId: string;
  filePath: string;
  vec: Float32Array;
}

const blobToFloat32 = (b: Uint8Array): Float32Array =>
  new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

const cosine = (a: Float32Array, b: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
};

// Hand-curated query → target pairs. Each query is a short, paraphrastic
// formulation that points at the target note without lifting phrases
// directly. Targets span all three enrichment waves (smoke-test 5,
// sub-agent wave-1 30, main-session wave-2 22, plus 3 from the wave-2
// auto sub-agent that wrote correctly).
const QUERIES: Array<{query: string; target: string}> = [
  // wave-2 main session 22
  {query: "single-file utility for compress/decompress dispatch in dotfiles", target: "topics/arx.md"},
  {query: "is this token in this set in bash without using arrays", target: "topics/bash-tokenized-set-membership.md"},
  {query: "encode intent in method name vs pass a string discriminator", target: "topics/intentional-programming.md"},
  {query: "Svelte component instantiated programmatically doesn't react to prop changes", target: "topics/svelte-prop-update-needs-flush-trigger.md"},
  {query: "my CSS custom property fallback is silently kicking in after a typo", target: "topics/css-vars-typo-silent-fallback.md"},
  {query: "should I always pin the latest version when adding an npm dep", target: "topics/dep-version-freshness.md"},
  {query: "Windows CI keeps failing prettier on every file, line endings", target: "topics/gitattributes-eol-lf.md"},
  {query: "rotate ad slots across pages on a Hugo site without per-page JS", target: "topics/hugo-deterministic-content-rotation.md"},
  {query: "Hugo build warning about Site.Data being deprecated", target: "topics/hugo-site-data-deprecated.md"},
  {query: "test fixture hangs forever when the port is already in use", target: "topics/port-busy-listen-race.md"},
  {query: "test framework reports a passed assertion but the promise actually rejected", target: "topics/promise-falsy-rejection-bug.md"},
  {query: "TypeScript can't find name node http even though types/node is installed", target: "topics/ts-module-node16-types-array.md"},
  {query: "API Gateway returns 403 MissingAuthenticationToken on HEAD requests", target: "topics/apigateway-rest-head-method-trap.md"},
  {query: "Hugo aliases redirect but search engines still index them", target: "topics/hugo-alias-default-no-noindex.md"},
  {query: "JSON-LD inside script tag is being string-encoded by Hugo template", target: "topics/hugo-jsonld-needs-safejs.md"},
  {query: "moving from URL scheme A to B on a Hugo site, what redirect strategy", target: "topics/static-site-redirect-strategy-aliases-vs-server.md"},
  {query: "DDoS made my AWS bill spike, is logging the cost driver", target: "topics/aws-cost-center-request-volume-not-logs.md"},
  {query: "is it bad practice to use labeled break in a function", target: "topics/break-continue-structured-goto.md"},
  {query: "bash printf %q quotes an empty string and breaks the next conditional", target: "topics/printf-q-empty-string-trap.md"},
  {query: "should the framework's pre-step run before or after the user's callback", target: "topics/builtin-step-before-user-hook.md"},
  {query: "config has a setting documented but changing the value does nothing", target: "topics/dead-config-setting.md"},
  {query: "DynamoDB ValidationException: Filter Expression can only contain non-primary key attributes", target: "topics/filterexpression-cannot-reference-key-attrs-under-keycondition.md"},
  // smoke test 5
  {query: "limit JSON body size in a Cloudflare Worker without OOM risk", target: "topics/web-fetch-body-size-cap.md"},
  {query: "should I use the same prefix for client meta-fields and DB-internal columns", target: "topics/wire-vs-db-field-prefixes.md"},
  {query: "two notes share a header but cover different topics, why are they reported as duplicate", target: "topics/embedding-aggregation-chunk-min-vs-doc-pool.md"},
  {query: "queue items keep showing as pending after the user fixes them by hand", target: "topics/auto-resolve-on-out-of-band-action.md"},
  {query: "how to economize on LLM tokens for bulk classification work", target: "topics/sub-agent-cheaper-model-bulk-judgment.md"},
  // sub-agent wave-1 sample
  {query: "is it cheaper to do hypothetical document expansion at index time or query time", target: "topics/hyde-at-ingest-amortizes.md"},
  {query: "where does the LLM spend money in an indexer-style system", target: "topics/agent-driven-llm-cost-boundary.md"},
  {query: "fields that should be computed automatically vs typed by hand", target: "topics/derived-state-not-authored.md"},
];

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const db = openDatabase({path: args.db});

  // Resolve target paths to record_ids.
  const recordRows = db.prepare(
    `SELECT record_id, file_path, body, agent_summary FROM records ORDER BY record_id`
  ).all() as Array<{record_id: string; file_path: string; body: string; agent_summary: string | null}>;
  const idByPath = new Map(recordRows.map(r => [r.file_path, r.record_id]));

  for (const q of QUERIES) {
    if (!idByPath.has(q.target)) {
      process.stderr.write(`unknown target: ${q.target}\n`);
      process.exit(1);
    }
  }
  process.stdout.write(`${QUERIES.length} query/target pairs loaded\n`);

  const chunkRows = db.prepare(
    `SELECT v.record_id, r.file_path, v.embedding
       FROM record_vec v JOIN records r ON r.record_id = v.record_id
       ORDER BY v.record_id, v.chunk_index`
  ).all() as Array<{record_id: string; file_path: string; embedding: Uint8Array}>;

  const modeA: Chunk[] = chunkRows.map(c => ({
    recordId: c.record_id,
    filePath: c.file_path,
    vec: blobToFloat32(c.embedding)
  }));

  const enriched = recordRows.filter(r => r.agent_summary !== null);
  process.stdout.write(`${enriched.length} enriched records → re-embedding body-only for mode B…\n`);

  const t0 = performance.now();
  const embedder = new BgeEmbedder();
  // For mode B, replace each enriched record's chunks with body-only re-embeds.
  // For non-enriched records, mode A's chunks already are body-only.
  const enrichedChunksB = new Map<string, Float32Array[]>();
  for (const r of enriched) {
    const chunks = chunkBody(r.body); // no summary
    const vecs = chunks.length > 0 ? await embedder.embedBatch(chunks) : [];
    enrichedChunksB.set(r.record_id, vecs);
  }
  const enrichedSet = new Set(enriched.map(r => r.record_id));
  const modeB: Chunk[] = modeA
    .filter(c => !enrichedSet.has(c.recordId))
    .concat(
      enriched.flatMap(r =>
        (enrichedChunksB.get(r.record_id) ?? []).map(vec => ({
          recordId: r.record_id, filePath: r.file_path, vec
        }))
      )
    );
  process.stdout.write(
    `mode-B chunks: ${modeB.length} (vs ${modeA.length} mode-A); re-embed time ${((performance.now() - t0) / 1000).toFixed(1)}s\n\n`
  );

  // Embed all queries once (queries are mode-agnostic — same input).
  process.stdout.write('embedding queries…\n');
  const queryTexts = QUERIES.map(q => q.query);
  const queryVecs = await embedder.embedBatch(queryTexts);

  // For each query in each mode, score against all chunks, find target's best rank.
  const scoreRun = (chunks: Chunk[]): Array<{q: string; target: string; targetRank: number; targetSim: number; topId: string; topSim: number}> => {
    const out = [];
    for (let i = 0; i < QUERIES.length; i++) {
      const q = QUERIES[i]!;
      const qv = queryVecs[i]!;
      const targetId = idByPath.get(q.target)!;
      // Score every chunk against the query.
      const scored: Array<{recordId: string; sim: number}> = chunks.map(c => ({
        recordId: c.recordId,
        sim: cosine(qv, c.vec)
      }));
      // Per-record best chunk score (max-sim aggregation).
      const bestPerRecord = new Map<string, number>();
      for (const s of scored) {
        const prev = bestPerRecord.get(s.recordId);
        if (prev === undefined || s.sim > prev) bestPerRecord.set(s.recordId, s.sim);
      }
      const ranked = [...bestPerRecord.entries()]
        .sort(([, a], [, b]) => b - a);
      const targetRank = ranked.findIndex(([rid]) => rid === targetId) + 1;
      const targetSim = bestPerRecord.get(targetId) ?? 0;
      const [topId, topSim] = ranked[0]!;
      out.push({q: q.query, target: q.target, targetRank, targetSim, topId, topSim});
    }
    return out;
  };

  process.stdout.write('scoring mode A (with-summary)…\n');
  const a = scoreRun(modeA);
  process.stdout.write('scoring mode B (body-only)…\n');
  const b = scoreRun(modeB);

  // Aggregate metrics.
  const aggregate = (rows: typeof a): {top1: number; top5: number; top10: number; mrr: number; meanRank: number} => {
    const top1 = rows.filter(r => r.targetRank === 1).length / rows.length;
    const top5 = rows.filter(r => r.targetRank <= 5).length / rows.length;
    const top10 = rows.filter(r => r.targetRank <= 10).length / rows.length;
    const mrr = rows.reduce((s, r) => s + 1 / r.targetRank, 0) / rows.length;
    const meanRank = rows.reduce((s, r) => s + r.targetRank, 0) / rows.length;
    return {top1, top5, top10, mrr, meanRank};
  };
  const aA = aggregate(a);
  const aB = aggregate(b);

  const fmt = (n: number, d = 4): string => n.toFixed(d);
  const delta = (na: number, nb: number): string => {
    const diff = na - nb;
    const sign = diff >= 0 ? '+' : '';
    const pct = nb !== 0 ? ((diff / nb) * 100).toFixed(1) : 'inf';
    return `${sign}${diff.toFixed(4)} (${sign}${pct}%)`;
  };

  process.stdout.write('\n=== Aggregate retrieval metrics over 30 query/target pairs ===\n');
  process.stdout.write('metric        A=with-summary   B=body-only      A − B\n');
  process.stdout.write(`top-1 hit     ${fmt(aA.top1)}            ${fmt(aB.top1)}            ${delta(aA.top1, aB.top1)}\n`);
  process.stdout.write(`top-5 hit     ${fmt(aA.top5)}            ${fmt(aB.top5)}            ${delta(aA.top5, aB.top5)}\n`);
  process.stdout.write(`top-10 hit    ${fmt(aA.top10)}            ${fmt(aB.top10)}            ${delta(aA.top10, aB.top10)}\n`);
  process.stdout.write(`MRR           ${fmt(aA.mrr)}            ${fmt(aB.mrr)}            ${delta(aA.mrr, aB.mrr)}\n`);
  process.stdout.write(`mean rank     ${aA.meanRank.toFixed(2)}             ${aB.meanRank.toFixed(2)}            ${(aA.meanRank - aB.meanRank).toFixed(2)}\n`);

  process.stdout.write('\n=== Per-query rank table (target rank: lower is better) ===\n');
  process.stdout.write('A_rank | B_rank | Δ (A − B)  | A_sim   | B_sim   | target\n');
  for (let i = 0; i < QUERIES.length; i++) {
    const ar = a[i]!;
    const br = b[i]!;
    const diff = ar.targetRank - br.targetRank;
    const sign = diff > 0 ? '+' : '';
    const tgt = ar.target.replace('topics/', '').replace('.md', '');
    process.stdout.write(
      `${String(ar.targetRank).padStart(6)} | ${String(br.targetRank).padStart(6)} |  ${sign}${diff.toString().padStart(3)}      | ${fmt(ar.targetSim, 3)} | ${fmt(br.targetSim, 3)} | ${tgt}\n`
    );
  }

  // Sign test: in how many query/target pairs did mode A beat mode B (lower rank)?
  let aWins = 0, bWins = 0, ties = 0;
  for (let i = 0; i < QUERIES.length; i++) {
    if (a[i]!.targetRank < b[i]!.targetRank) aWins++;
    else if (a[i]!.targetRank > b[i]!.targetRank) bWins++;
    else ties++;
  }
  process.stdout.write(`\n=== Sign test (which mode retrieved target at a better rank?) ===\n`);
  process.stdout.write(`A wins (with-summary better): ${aWins}\n`);
  process.stdout.write(`B wins (body-only better):    ${bWins}\n`);
  process.stdout.write(`ties:                          ${ties}\n`);

  db.close();
};

await main();
