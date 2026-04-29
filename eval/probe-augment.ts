// Empirical test: does prepending Claude-generated "what this note is about"
// to the body produce better embeddings than the raw body? Tests the
// "AI-agent-as-embedder-improver" hypothesis without needing API access to
// hidden states. The summaries below were written by Claude inline based on
// reading the notes during the 2026-04-28 session — they're auxiliary text,
// not the body itself.
//
// We test 7 known-related pairs and 3 known-unrelated pairs across three
// representations:
//   (a) body alone (current behaviour)
//   (b) title + tags + body
//   (c) llm-summary + title + tags + body
//
// If (c) shows a wider RELATED-vs-UNRELATED similarity gap than (a), that's
// evidence the LLM-augmentation path is worth implementing across the vault.

import {readFileSync} from 'node:fs';
import {parseFrontmatter} from '../src/markdown/frontmatter.ts';
import {BgeEmbedder} from '../src/embeddings/bge.ts';

const root = "/media/raid/Vault/Eugene's vault";

interface Note {
  path: string;
  /** Claude-generated 1-line summary based on reading the note. */
  summary: string;
}

const notes: Note[] = [
  {
    path: 'projects/vault-storage/queue.md',
    summary:
      'Outstanding research and design tasks for the vault-storage project: data model, REST API surface, MCP layer, frontmatter handling, atomization splitter, deployment, embeddings model lock, edge taxonomy.'
  },
  {
    path: 'projects/vault-storage/learnings.md',
    summary:
      'Meta-observations from the vault-storage design phase: how an audit-first approach grounded decisions, the pivots driven by user input (atomization, frontmatter ownership, agent-driven intelligence), what was harder vs. easier than expected.'
  },
  {
    path: 'projects/vault-storage/design/embedding-model.md',
    summary:
      'Embedding model and dimension lock for the vault-storage project. BGE-small-en-v1.5, 384 dim, float32, via @huggingface/transformers. CLS pooling, chunked input. Evaluation plan and swap triggers documented.'
  },
  {
    path: 'projects/vault-storage/design/embedding-baseline.md',
    summary:
      'First-run baseline of embedding quality metrics for BGE-small on the live vault: Precision@5, Recall@10, negative discrimination, tag-cluster purity, plus code-heavy and wikilink-context spot-checks.'
  },
  {
    path: 'projects/vault-storage/design/backend-comparison.md',
    summary:
      'Comparison of candidate backends for vault-storage v1: SQLite + sqlite-vec wins on minimal-stack, file-as-source-of-truth, single-process deployment. Postgres + pgvector + Apache AGE documented as the future upgrade target.'
  },
  {
    path: 'projects/vault-storage/design/constraints.md',
    summary:
      'Architectural constraints C1 through C16 for the vault-storage project: local-first Docker deployment, files as source of truth, AI-agent-first API, lossless import, atomization, agent-driven intelligence, no LLM in indexer.'
  },
  {
    path: 'topics/portable-bash-patterns.md',
    summary:
      'POSIX-portable bash idioms and pitfalls: handling spaces in paths, IFS gotchas, set -euo pipefail caveats, dash vs bash divergences. Cross-project utility patterns gathered while building dotfiles infrastructure.'
  },
  {
    path: 'topics/single-quote-awk-apostrophe-trap.md',
    summary:
      'Bash gotcha: an apostrophe inside a single-quoted awk program closes the surrounding shell quoted string mid-program. The shell error message points at the wrong line, making the connection non-obvious.'
  },
  {
    path: 'topics/gawk-mawk-portability.md',
    summary:
      'Portability differences between gawk and mawk: gawk-only features (like the 3-arg match() with capture-group array) that silently fail on mawk. Workaround patterns using 2-arg match plus RSTART/RLENGTH.'
  }
];

interface Pair {
  a: string; // path
  b: string; // path
  related: boolean;
}

const pairs: Pair[] = [
  {a: 'projects/vault-storage/queue.md', b: 'projects/vault-storage/learnings.md', related: true},
  {a: 'projects/vault-storage/design/embedding-model.md', b: 'projects/vault-storage/design/backend-comparison.md', related: true},
  {a: 'projects/vault-storage/design/embedding-model.md', b: 'projects/vault-storage/design/embedding-baseline.md', related: true},
  {a: 'projects/vault-storage/design/embedding-model.md', b: 'projects/vault-storage/design/constraints.md', related: true},
  {a: 'topics/portable-bash-patterns.md', b: 'topics/single-quote-awk-apostrophe-trap.md', related: true},
  {a: 'topics/portable-bash-patterns.md', b: 'topics/gawk-mawk-portability.md', related: true},
  {a: 'topics/single-quote-awk-apostrophe-trap.md', b: 'topics/gawk-mawk-portability.md', related: true},
  {a: 'projects/vault-storage/queue.md', b: 'topics/portable-bash-patterns.md', related: false},
  {a: 'projects/vault-storage/design/embedding-model.md', b: 'topics/gawk-mawk-portability.md', related: false},
  {a: 'projects/vault-storage/learnings.md', b: 'topics/single-quote-awk-apostrophe-trap.md', related: false}
];

const dot = (x: Float32Array, y: Float32Array): number => {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i]! * y[i]!;
  return s;
};

const fileContent = (p: string): {title: string; tags: string[]; body: string} => {
  const src = readFileSync(`${root}/${p}`, 'utf8');
  const {data, body} = parseFrontmatter(src);
  const title = typeof data['title'] === 'string' ? data['title'] : '';
  const tags = Array.isArray(data['tags']) ? data['tags'].filter((x): x is string => typeof x === 'string') : [];
  return {title, tags, body};
};

const compose = {
  raw: (n: Note) => fileContent(n.path).body,
  titleTags: (n: Note): string => {
    const {title, tags, body} = fileContent(n.path);
    return `${title}\n${tags.join(', ')}\n\n${body}`;
  },
  summaryTitleTags: (n: Note): string => {
    const {title, tags, body} = fileContent(n.path);
    return `${n.summary}\n\n${title}\n${tags.join(', ')}\n\n${body}`;
  }
};

const noteMap = new Map(notes.map(n => [n.path, n]));

const evalRepresentation = async (label: string, composer: (n: Note) => string): Promise<void> => {
  const embedder = new BgeEmbedder({pooling: 'cls', maxChars: 1500});
  const vecByPath = new Map<string, Float32Array>();
  for (const n of notes) vecByPath.set(n.path, await embedder.embed(composer(n)));

  let relSum = 0, relN = 0;
  let unrelSum = 0, unrelN = 0;
  process.stdout.write(`\n=== ${label} ===\n`);
  for (const p of pairs) {
    const va = vecByPath.get(p.a)!;
    const vb = vecByPath.get(p.b)!;
    const sim = dot(va, vb);
    const tag = p.related ? '✓' : '·';
    process.stdout.write(`  ${tag} ${sim.toFixed(4)}  ${p.a.split('/').pop()}  ↔  ${p.b.split('/').pop()}\n`);
    if (p.related) { relSum += sim; relN++; } else { unrelSum += sim; unrelN++; }
  }
  const relMean = relSum / relN;
  const unrelMean = unrelSum / unrelN;
  process.stdout.write(`  RELATED mean=${relMean.toFixed(4)}, UNRELATED mean=${unrelMean.toFixed(4)}, gap=${(relMean - unrelMean).toFixed(4)}\n`);
};

await evalRepresentation('(a) body only', n => compose.raw(n));
await evalRepresentation('(b) title + tags + body', n => compose.titleTags(n));
await evalRepresentation('(c) Claude-summary + title + tags + body', n => compose.summaryTitleTags(n));

void noteMap; // silence unused
