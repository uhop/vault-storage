// Query-document retrieval check for `agent.summary`: prefixed to every chunk
// (A, production from schema 5 to D45), left out (B), or embedded once as its
// own vector and scored with the best body chunk, as their maximum (C) or as
// the server's `recordSimilarity` blend (D, D45).
//
//   node eval/embedding-summary-query-ab.ts --db <vault.sqlite> --cache <dir> [--vectors-from <vault.sqlite>] [--sample N] [--seed S]
//
// Query sets: `paraphrase`, 30 hand-curated short queries with a known target
// (2026-05-01); `sentence`, one sentence lifted from the body of each sampled
// enriched note, whose target is that note (the dilution check of the queue
// item "Semantic search misses a large note's own wording"); `title`, each
// sampled note's title, a short name written apart from both the body and the
// summary (64 of 1,911 enriched titles occur in their body). A record scores
// as its best vector; a target's rank is 1 + the records scoring strictly
// higher. Vectors are cached by text hash, so a rerun embeds only new texts.
// `--vectors-from` seeds the cache from a server database's chunks by their
// `text_hash` (schema 0023), which covers mode A without re-embedding: the
// model already uses every core, so parallel processes do not help.

import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  truncateSync,
  writeSync
} from 'node:fs';
import {join} from 'node:path';
import {openDatabase} from '../src/db/connection.ts';
import {BgeEmbedder} from '../src/embeddings/bge.ts';
import {recordSimilarity} from '../src/db/vec-repo.ts';
import {chunkBody} from '../src/embeddings/chunker.ts';
import {contentHash} from '../src/util/hash.ts';

interface Args {
  db: string;
  cache: string;
  sample: number;
  seed: number;
  vectorsFrom: string;
}

const parseArgs = (argv: string[]): Args => {
  const args: Args = {db: '', cache: '', vectorsFrom: '', sample: 0, seed: 1};
  for (let i = 0; i < argv.length; ++i) {
    const a = argv[i];
    if (a === '--db') args.db = argv[++i] ?? '';
    else if (a === '--cache') args.cache = argv[++i] ?? '';
    else if (a === '--sample') args.sample = Number.parseInt(argv[++i] ?? '0', 10);
    else if (a === '--seed') args.seed = Number.parseInt(argv[++i] ?? '1', 10);
    else if (a === '--vectors-from') args.vectorsFrom = argv[++i] ?? '';
    else {
      process.stderr.write(`unknown argument: ${a}\n`);
      process.exit(2);
    }
  }
  if (!args.db || !args.cache) {
    process.stderr.write(
      'usage: embedding-summary-query-ab.ts --db <path> --cache <dir> [--vectors-from <path>] [--sample N] [--seed S]\n'
    );
    process.exit(2);
  }
  return args;
};

// Hand-curated query → target pairs. Each query is a short, paraphrastic
// formulation that points at the target note without lifting phrases
// directly. Targets span all three enrichment waves (smoke-test 5,
// sub-agent wave-1 30, main-session wave-2 22, plus 3 from the wave-2
// auto sub-agent that wrote correctly).
const QUERIES: Array<{query: string; target: string}> = [
  // wave-2 main session 22
  {
    query: 'single-file utility for compress/decompress dispatch in dotfiles',
    target: 'topics/arx.md'
  },
  {
    query: 'is this token in this set in bash without using arrays',
    target: 'topics/bash-tokenized-set-membership.md'
  },
  {
    query: 'encode intent in method name vs pass a string discriminator',
    target: 'topics/intentional-programming.md'
  },
  {
    query: "Svelte component instantiated programmatically doesn't react to prop changes",
    target: 'topics/svelte-prop-update-needs-flush-trigger.md'
  },
  {
    query: 'my CSS custom property fallback is silently kicking in after a typo',
    target: 'topics/css-vars-typo-silent-fallback.md'
  },
  {
    query: 'should I always pin the latest version when adding an npm dep',
    target: 'topics/dep-version-freshness.md'
  },
  {
    query: 'Windows CI keeps failing prettier on every file, line endings',
    target: 'topics/gitattributes-eol-lf.md'
  },
  {
    query: 'rotate ad slots across pages on a Hugo site without per-page JS',
    target: 'topics/hugo-deterministic-content-rotation.md'
  },
  {
    query: 'Hugo build warning about Site.Data being deprecated',
    target: 'topics/hugo-site-data-deprecated.md'
  },
  {
    query: 'test fixture hangs forever when the port is already in use',
    target: 'topics/port-busy-listen-race.md'
  },
  {
    query: 'test framework reports a passed assertion but the promise actually rejected',
    target: 'topics/promise-falsy-rejection-bug.md'
  },
  {
    query: "TypeScript can't find name node http even though types/node is installed",
    target: 'topics/ts-module-node16-types-array.md'
  },
  {
    query: 'API Gateway returns 403 MissingAuthenticationToken on HEAD requests',
    target: 'topics/apigateway-rest-head-method-trap.md'
  },
  {
    query: 'Hugo aliases redirect but search engines still index them',
    target: 'topics/hugo-alias-default-no-noindex.md'
  },
  {
    query: 'JSON-LD inside script tag is being string-encoded by Hugo template',
    target: 'topics/hugo-jsonld-needs-safejs.md'
  },
  {
    query: 'moving from URL scheme A to B on a Hugo site, what redirect strategy',
    target: 'topics/static-site-redirect-strategy-aliases-vs-server.md'
  },
  {
    query: 'DDoS made my AWS bill spike, is logging the cost driver',
    target: 'topics/aws-cost-center-request-volume-not-logs.md'
  },
  {
    query: 'is it bad practice to use labeled break in a function',
    target: 'topics/break-continue-structured-goto.md'
  },
  {
    query: 'bash printf %q quotes an empty string and breaks the next conditional',
    target: 'topics/printf-q-empty-string-trap.md'
  },
  {
    query: "should the framework's pre-step run before or after the user's callback",
    target: 'topics/builtin-step-before-user-hook.md'
  },
  {
    query: 'config has a setting documented but changing the value does nothing',
    target: 'topics/dead-config-setting.md'
  },
  {
    query:
      'DynamoDB ValidationException: Filter Expression can only contain non-primary key attributes',
    target: 'topics/filterexpression-cannot-reference-key-attrs-under-keycondition.md'
  },
  // smoke test 5
  {
    query: 'limit JSON body size in a Cloudflare Worker without OOM risk',
    target: 'topics/web-fetch-body-size-cap.md'
  },
  {
    query: 'should I use the same prefix for client meta-fields and DB-internal columns',
    target: 'topics/wire-vs-db-field-prefixes.md'
  },
  {
    query:
      'two notes share a header but cover different topics, why are they reported as duplicate',
    target: 'topics/embedding-aggregation-chunk-min-vs-doc-pool.md'
  },
  {
    query: 'queue items keep showing as pending after the user fixes them by hand',
    target: 'topics/auto-resolve-on-out-of-band-action.md'
  },
  {
    query: 'how to economize on LLM tokens for bulk classification work',
    target: 'topics/sub-agent-cheaper-model-bulk-judgment.md'
  },
  // sub-agent wave-1 sample
  {
    query: 'is it cheaper to do hypothetical document expansion at index time or query time',
    target: 'topics/hyde-at-ingest-amortizes.md'
  },
  {
    query: 'where does the LLM spend money in an indexer-style system',
    target: 'topics/agent-driven-llm-cost-boundary.md'
  },
  {
    query: 'fields that should be computed automatically vs typed by hand',
    target: 'topics/derived-state-not-authored.md'
  }
];

// The miss that opened the retrieval item: a near-verbatim D44 sentence.
const PROBES: Array<{query: string; target: string}> = [
  {
    query:
      'the native binding loads once per process, so a restarted worker fails with Module did not self-register',
    target: 'projects/vault-storage/decisions.md'
  }
];

const DIM = 384;
const ENTRY_BYTES = 32 + DIM * 4;
const EMBED_BATCH = 64;

const isFinite384 = (v: Float32Array): boolean => v.every(Number.isFinite);

class VectorCache {
  readonly #path: string;
  readonly #vectors = new Map<string, Float32Array>();

  constructor(dir: string, writer: string) {
    mkdirSync(dir, {recursive: true});
    this.#path = join(dir, `${writer}.bin`);
    for (const name of readdirSync(dir).filter(n => n.endsWith('.bin'))) {
      const path = join(dir, name);
      const buf = readFileSync(path);
      const whole = buf.length - (buf.length % ENTRY_BYTES);
      // A torn tail is an interrupted append; another shard's file may be mid-append now.
      if (path === this.#path && whole < buf.length) truncateSync(path, whole);
      for (let off = 0; off < whole; off += ENTRY_BYTES) {
        const vec = new Float32Array(DIM);
        for (let i = 0; i < DIM; ++i) vec[i] = buf.readFloatLE(off + 32 + i * 4);
        this.#offer(buf.toString('hex', off, off + 32), vec);
      }
    }
  }

  // A stored non-finite vector (the embed pass persists an all-NaN record) is re-embedded.
  #offer(hash: string, vec: Float32Array): void {
    if (vec.length === DIM && isFinite384(vec)) this.#vectors.set(hash, vec);
  }

  importFromDb(path: string): number {
    const db = openDatabase({path});
    const rows = db
      .prepare(
        `SELECT c.text_hash AS hash, v.embedding AS embedding
           FROM chunks c
           JOIN record_vec v ON v.chunk_id = c.chunk_id
          WHERE c.text_hash IS NOT NULL`
      )
      .all() as unknown[] as {hash: string; embedding: Uint8Array}[];
    db.close();
    const before = this.#vectors.size;
    for (const r of rows) {
      if (this.#vectors.has(r.hash)) continue;
      const bytes = r.embedding.slice();
      this.#offer(r.hash, new Float32Array(bytes.buffer, 0, bytes.byteLength / 4));
    }
    return this.#vectors.size - before;
  }

  get size(): number {
    return this.#vectors.size;
  }

  get(text: string): Float32Array {
    const vec = this.#vectors.get(contentHash(text));
    if (!vec) throw new Error(`no cached vector for text: ${text.slice(0, 80)}`);
    return vec;
  }

  async fill(texts: Iterable<string>, embedder: BgeEmbedder): Promise<number> {
    const missing = new Map<string, string>();
    for (const t of texts) {
      const h = contentHash(t);
      if (!this.#vectors.has(h)) missing.set(h, t);
    }
    const entries = [...missing];
    const start = performance.now();
    const fd = openSync(this.#path, 'a');
    try {
      for (let off = 0; off < entries.length; off += EMBED_BATCH) {
        const slice = entries.slice(off, off + EMBED_BATCH);
        const vecs = await embedder.embedBatch(slice.map(([, t]) => t));
        const buf = Buffer.alloc(slice.length * ENTRY_BYTES);
        slice.forEach(([h, t], j) => {
          const vec = vecs[j]!;
          if (vec.length !== DIM) throw new Error(`dimension ${vec.length} for ${t.slice(0, 80)}`);
          buf.write(h, j * ENTRY_BYTES, 'hex');
          for (let i = 0; i < DIM; ++i) buf.writeFloatLE(vec[i]!, j * ENTRY_BYTES + 32 + i * 4);
          this.#offer(h, vec);
        });
        writeSync(fd, buf);
        const done = Math.min(off + EMBED_BATCH, entries.length);
        const rate = done / ((performance.now() - start) / 1000);
        process.stderr.write(`embedded ${done}/${entries.length} (${rate.toFixed(1)}/s)\n`);
      }
    } finally {
      closeSync(fd);
    }
    return entries.length;
  }
}

interface RecordRow {
  record_id: string;
  file_path: string;
  title: string | null;
  body: string;
  agent_summary: string | null;
}

// Rows of vectors, each owned by one record.
interface Matrix {
  rows: Float32Array;
  owner: Int32Array;
}

const buildMatrix = (perRecord: Float32Array[][]): Matrix => {
  const count = perRecord.reduce((n, vecs) => n + vecs.length, 0);
  const rows = new Float32Array(count * DIM);
  const owner = new Int32Array(count);
  let r = 0;
  perRecord.forEach((vecs, rec) => {
    for (const v of vecs) {
      rows.set(v, r * DIM);
      owner[r++] = rec;
    }
  });
  return {rows, owner};
};

// Each record's best row similarity to the query; -Infinity for a record with no rows.
const bestPerRecord = (m: Matrix, query: Float32Array, recordCount: number): Float64Array => {
  const best = new Float64Array(recordCount).fill(-Infinity);
  const {rows, owner} = m;
  for (let r = 0; r < owner.length; ++r) {
    let s = 0;
    const base = r * DIM;
    for (let i = 0; i < DIM; ++i) s += rows[base + i]! * query[i]!;
    const o = owner[r]!;
    if (s > best[o]!) best[o] = s;
  }
  return best;
};

const rankIn = (scores: ArrayLike<number>, target: number): number => {
  const t = scores[target]!;
  let higher = 0;
  for (let i = 0; i < scores.length; ++i) if (scores[i]! > t) ++higher;
  return higher + 1;
};

interface Mode {
  name: string;
  score: (chunkA: number, chunkB: number, summary: number | null) => number;
}

const MODES: Mode[] = [
  {name: 'A', score: a => a},
  {name: 'B', score: (_, b) => b},
  {name: 'C', score: (_, b, s) => (s === null ? b : Math.max(b, s))},
  {name: 'D', score: (_, b, s) => recordSimilarity(b, s)}
];

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const sentencesOf = (body: string): string[] =>
  body
    .replace(/```[\s\S]*?```/g, '\n')
    .split(/\n+/)
    .filter(line => !/^\s*(#|\||>|---)/.test(line))
    .flatMap(line => line.split(/(?<=[.!?])\s+/))
    .map(s =>
      s
        .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
        .replace(/\*\*|`|\[\[|\]\]/g, '')
        .trim()
    )
    .filter(s => s.length >= 60 && s.length <= 220);

// Exact two-sided sign test over the non-tied pairs.
const signTestP = (wins: number, losses: number): number => {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let logPmf = -n * Math.LN2;
  let tail = 0;
  for (let i = 0; i <= k; ++i) {
    tail += Math.exp(logPmf);
    logPmf += Math.log(n - i) - Math.log(i + 1);
  }
  return Math.min(1, 2 * tail);
};

interface Query {
  set: string;
  query: string;
  target: number;
  stratum: string;
}

const stratumOf = (chunks: number): string =>
  chunks === 1
    ? '1 chunk'
    : chunks <= 10
      ? '2-10 chunks'
      : chunks <= 100
        ? '11-100 chunks'
        : '>100 chunks';

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const db = openDatabase({path: args.db});
  const records = db
    .prepare(
      'SELECT record_id, file_path, title, body, agent_summary FROM records ORDER BY record_id'
    )
    .all() as unknown[] as RecordRow[];
  db.close();
  const indexByPath = new Map(records.map((r, i) => [r.file_path, i]));
  const summaryOf = (r: RecordRow): string | null =>
    r.agent_summary && r.agent_summary.length > 0 ? r.agent_summary : null;

  const textsB = records.map(r => chunkBody(r.body));
  // Mode A as the chunker built it through D44: the summary prefixed to each body chunk.
  const textsA = records.map((r, i) => {
    const summary = summaryOf(r);
    return summary === null ? textsB[i]! : textsB[i]!.map(c => `${summary}\n\n${c}`);
  });

  const queries: Query[] = [];
  for (const [set, list] of [
    ['paraphrase', QUERIES],
    ['probe', PROBES]
  ] as const) {
    for (const q of list) {
      const target = indexByPath.get(q.target);
      if (target === undefined) throw new Error(`unknown target: ${q.target}`);
      queries.push({set, query: q.query, target, stratum: stratumOf(textsB[target]!.length)});
    }
  }
  const random = mulberry32(args.seed);
  const enriched = records.flatMap((r, i) => (summaryOf(r) ? [i] : []));
  for (let i = enriched.length - 1; i > 0; --i) {
    const j = Math.floor(random() * (i + 1));
    [enriched[i], enriched[j]] = [enriched[j]!, enriched[i]!];
  }
  const sampled = args.sample > 0 ? enriched.slice(0, args.sample) : enriched;
  let noSentence = 0;
  for (const i of sampled) {
    const title = records[i]!.title;
    if (title)
      queries.push({set: 'title', query: title, target: i, stratum: stratumOf(textsB[i]!.length)});
    const candidates = sentencesOf(records[i]!.body);
    if (candidates.length === 0) {
      ++noSentence;
      continue;
    }
    const query = candidates[Math.floor(random() * candidates.length)]!;
    queries.push({set: 'sentence', query, target: i, stratum: stratumOf(textsB[i]!.length)});
  }

  const cache = new VectorCache(args.cache, 'main');
  const imported = args.vectorsFrom ? cache.importFromDb(args.vectorsFrom) : 0;
  process.stderr.write(`cache holds ${cache.size} vectors, ${imported} from --vectors-from\n`);
  const embedder = new BgeEmbedder();
  const summaries = records.flatMap(r => summaryOf(r) ?? []);
  const embeddedNow = await cache.fill(
    [...textsA.flat(), ...textsB.flat(), ...summaries, ...queries.map(q => q.query)],
    embedder
  );
  await embedder.releaseRetained();

  const vecsOf = (texts: string[]): Float32Array[] =>
    texts.map(t => cache.get(t)).filter(isFinite384);
  const matrixA = buildMatrix(textsA.map(vecsOf));
  const matrixB = buildMatrix(textsB.map(vecsOf));
  const summaryVecs = records.map(r => {
    const s = summaryOf(r);
    return s === null ? [] : vecsOf([s]);
  });
  const matrixS = buildMatrix(summaryVecs);
  const modes = MODES;

  process.stdout.write(
    `records ${records.length}, enriched ${enriched.length}, sampled ${sampled.length} ` +
      `(${noSentence} without a usable sentence), embedded now ${embeddedNow}\n` +
      `rows: A ${matrixA.owner.length}, B ${matrixB.owner.length}, summaries ${matrixS.owner.length}\n` +
      'A = summary prefixed to every chunk; B = body chunks only; C = max(best chunk, summary); ' +
      'D = recordSimilarity(best chunk, summary)\n\n'
  );

  const ranks = queries.map(q => {
    const vec = cache.get(q.query);
    const chunkA = bestPerRecord(matrixA, vec, records.length);
    const chunkB = bestPerRecord(matrixB, vec, records.length);
    const summary = bestPerRecord(matrixS, vec, records.length);
    return modes.map(m =>
      rankIn(
        records.map((_, i) =>
          m.score(chunkA[i]!, chunkB[i]!, summary[i] === -Infinity ? null : summary[i]!)
        ),
        q.target
      )
    );
  });

  const report = (label: string, picked: number[]): void => {
    if (picked.length === 0) return;
    process.stdout.write(`=== ${label} (${picked.length} queries) ===\n`);
    process.stdout.write('mode   top-1   top-5   top-10  MRR     median  mean rank\n');
    modes.forEach((m, k) => {
      const rs = picked.map(q => ranks[q]![k]!).sort((a, b) => a - b);
      const share = (limit: number): string =>
        (rs.filter(r => r <= limit).length / rs.length).toFixed(3);
      const mrr = rs.reduce((s, r) => s + 1 / r, 0) / rs.length;
      const mean = rs.reduce((s, r) => s + r, 0) / rs.length;
      const median = rs[Math.floor((rs.length - 1) / 2)]!;
      process.stdout.write(
        `${m.name.padEnd(7)}${share(1)}   ${share(5)}   ${share(10)}   ${mrr.toFixed(3)}   ` +
          `${String(median).padEnd(8)}${mean.toFixed(1)}\n`
      );
    });
    for (const [x, y] of [
      [0, 1],
      [1, 2],
      [2, 3],
      [0, 2],
      [0, 3]
    ] as const) {
      let xWins = 0;
      let yWins = 0;
      for (const q of picked) {
        const rx = ranks[q]![x]!;
        const ry = ranks[q]![y]!;
        if (rx < ry) ++xWins;
        else if (ry < rx) ++yWins;
      }
      const ties = picked.length - xWins - yWins;
      process.stdout.write(
        `${modes[x]!.name} vs ${modes[y]!.name}: ${modes[x]!.name} better ${xWins}, ` +
          `${modes[y]!.name} better ${yWins}, tied ${ties}, sign test p=${signTestP(xWins, yWins).toPrecision(3)}\n`
      );
    }
    process.stdout.write('\n');
  };

  const indicesWhere = (pred: (q: Query) => boolean): number[] =>
    queries.flatMap((q, i) => (pred(q) ? [i] : []));

  report(
    'paraphrase',
    indicesWhere(q => q.set === 'paraphrase')
  );
  report(
    'sentence',
    indicesWhere(q => q.set === 'sentence')
  );
  report(
    'title',
    indicesWhere(q => q.set === 'title')
  );
  for (const [set, stratum] of ['sentence', 'title'].flatMap(set =>
    ['1 chunk', '2-10 chunks', '11-100 chunks', '>100 chunks'].map(
      stratum => [set, stratum] as const
    )
  )) {
    report(
      `${set}, ${stratum}`,
      indicesWhere(q => q.set === set && q.stratum === stratum)
    );
  }

  process.stdout.write(
    '=== per-query ranks: paraphrase and probe ===\nA      B      C      D      target\n'
  );
  for (const i of indicesWhere(q => q.set === 'paraphrase' || q.set === 'probe')) {
    process.stdout.write(
      `${ranks[i]!.map(r => String(r).padEnd(7)).join('')}${records[queries[i]!.target]!.file_path}\n`
    );
  }

  const show = (label: string, list: number[]): void => {
    process.stdout.write(`\n=== ${label} ===\nA      D      chunks  target | query\n`);
    for (const i of list) {
      const q = queries[i]!;
      process.stdout.write(
        `${String(ranks[i]![0]).padEnd(7)}${String(ranks[i]![3]).padEnd(7)}` +
          `${String(textsB[q.target]!.length).padEnd(8)}${records[q.target]!.file_path} | ${q.query}\n`
      );
    }
  };
  for (const set of ['sentence', 'title']) {
    const byDelta = indicesWhere(q => q.set === set).sort(
      (x, y) => ranks[x]![3]! - ranks[x]![0]! - (ranks[y]![3]! - ranks[y]![0]!)
    );
    show(`${set}: D most better than A`, byDelta.slice(0, 5));
    show(`${set}: D most worse than A`, byDelta.slice(-5).reverse());
  }
};

await main();
