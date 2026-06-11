---
name: vault-propose-related
description: "Propose missing `related:` entries for vault notes by reviewing BGE-retrieval candidates. Use when the user says /vault propose-related, asks to densify cross-references in the vault, or wants to expand `related:` arrays without reading every note manually. Loads top-N nearest neighbours per source note (excluding existing related: and body wikilinks), reasons about which are genuine semantic matches, writes accepted proposals to a review note in the vault."
user_invocable: true
---

# Propose missing `related:` entries

The vault's hand-curated `related:` arrays are **sparse** — typically 1–3 entries per note, while many notes have 8–15 genuinely related neighbours. This sparsity caps the embedding-quality eval at low absolute precision/recall numbers and leaves the knowledge graph thinner than it could be. This skill closes the gap by combining the existing BGE retrieval index (which surfaces candidates cheaply) with LLM judgment (which decides which candidates are *meaningful* relationships).

The skill is **suggestion-only** — proposals are written into a vault note for human review, not auto-applied to source notes. This matches the design's agent-driven-suggestions model (C16).

## Prerequisites

A populated vault-storage SQLite DB built from the live vault. If one doesn't exist, build it first from `~/Open/vault-storage/`:

```bash
cd ~/Open/vault-storage
VAULT_DB_PATH=/tmp/vault.sqlite node src/index.ts import /path/to/vault-data
```

The import takes ~10–15 minutes (full re-embed). Subsequent runs are nearly instant if the body content_hashes haven't changed.

## Procedure

### 1. Extract candidates

Run the candidate extractor for the next batch of source notes. Default batch size is 30 (one session can review more if needed):

```bash
cd ~/Open/vault-storage
node eval/propose-related.ts \
  --db /tmp/vault.sqlite \
  --vault /path/to/vault-data \
  --output /tmp/related-candidates.tsv \
  --per-note 10 \
  --limit 30
```

Output: `/tmp/related-candidates.md` (review-friendly grouped markdown) and `/tmp/related-candidates.tsv` (machine-parseable).

The extractor:
- Loads each source note's first chunk vector as the query
- Returns top-N nearest records by chunk-aware max-sim (default N = `per-note × 3` chunks aggregated to records, then trimmed to per-note records)
- Excludes self, existing `related:` entries (resolved via the same wikilink resolver the importer uses), and existing body `[[wikilinks]]`
- The remaining are *new* candidates, sorted by cosine distance (nearest first)

### 2. Review candidates

Read `/tmp/related-candidates.md`. For each source note's candidate list:

- **Accept** a candidate if you would write it into the source note's `related:` array based on a brief check of both notes' titles, tags, and the candidate's bullet entry. Heuristics:
  - Same project / same major topic area → almost certainly related
  - Subject overlap with clear semantic linkage → related
  - Same problem, different angle (e.g., "bash patterns" ↔ "specific bash gotcha") → related
  - Tangentially similar (both technical, no direct connection) → skip
  - Same word in title but different meaning (homonym) → skip
- **Skip** ambiguous candidates rather than guessing — the cost of a wrong "accept" (user reviews and removes it) is higher than a "skip" (user gets fewer suggestions).

For each source note, you may need to read the candidate note via `vault-curl /vault/<path> -s` if the title alone doesn't disambiguate. Read sparingly — the goal is a fast batch pass, not exhaustive verification.

The candidate extractor uses a **distance cap of 0.30** (cosine ≥ 0.70) by default, which is the **99%-recall operating point** on the curated `related:` set — only 1% of real relationships fall above this cap. The cost is a wider candidate list per note (~5–20 typical, more for hub-like notes), with the LLM judgment layer (you) filtering the noise.

**Why high recall over precision**: a false-positive candidate is bounded cost — you check it, decide skip, move on. A false-negative is unbounded cost — a relationship that exists but never got proposed becomes a latent bug in the knowledge graph, surfacing as "I should have noticed this connection ages ago" at the worst time. We tilt heavily toward recall.

When deciding accept/skip per candidate:
- distance ≤ 0.20 (cosine ≥ 0.80): accept by default; only skip if the candidate is clearly homonymous or topically off
- 0.20 < distance ≤ 0.25 (cosine 0.75–0.80): default-accept on subject-overlap, skip if only superficially similar
- 0.25 < distance ≤ 0.30 (cosine 0.70–0.75): be selective; accept only with strong topical justification
- > 0.30: filtered out by the extractor (won't appear in the candidates file)

### 3. Write the proposals note

Save to the vault as `queries/YYYY-MM-DD-related-proposals[-N].md` (use a sequence suffix if multiple batches in one day):

```yaml
---
title: Related-edge proposals — YYYY-MM-DD batch N
tags: [vault, related-proposals, query]
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: pending-review
type: query
related: ["[[projects/vault-storage/queue]]", "[[projects/vault-storage/design/embedding-baseline]]"]
---
```

Body structure: one section per source note. For each, list accepted proposals as wikilinks with a one-line rationale. Skipped/rejected candidates can be omitted, but flag any *ambiguous* ones in a "needs human verdict" section.

```markdown
## `<source-note-path>`

**Add to `related:`**:
- `[[<candidate-1>]]` — <one-line reason: e.g., "same project; covers the schema-decision side of <topic>">
- `[[<candidate-2>]]` — <reason>

**Ambiguous (human verdict needed)**:
- `[[<candidate-3>]]` — <why it's borderline>
```

Save with `vault-curl /vault/queries/YYYY-MM-DD-related-proposals.md -X PUT -H 'Content-Type: text/markdown' --data-binary @-`.

### 4. Update the vault index

Add an entry under `## Recent Queries` in `_index.md` so the proposals note is discoverable:

```
- [[queries/YYYY-MM-DD-related-proposals]] — Related-edge proposals batch N (M source notes, K accepted)
```

### 5. Tell the user

Report:
- Number of source notes reviewed in this batch
- Number of accepted proposals
- Number of ambiguous flagged-for-review entries
- Path to the proposals note
- Suggestion: "review the proposals note; reply 'apply' to fold accepted entries into source notes' frontmatter, or apply manually in Obsidian"

## Output discipline

- **Be conservative on accepts**. Better to under-suggest and let the user run another batch than to flood a source note with weak `related:` entries.
- **Don't auto-apply** — the user reviews first. The skill's value is the LLM judgment layer between brute-force retrieval and human curation; that layer is only trustworthy if its outputs go through human review.
- **Track which notes have been reviewed**. The extractor's `--limit` walks records in DB order; for subsequent batches use `--offset N` to skip already-reviewed source notes. (TODO: extractor doesn't yet support `--offset` — file as a follow-up; for now, manually exclude already-reviewed paths in your accept logic.)

## When NOT to use this skill

- **Per-query semantic search** — that's runtime BGE retrieval, not this offline pass. The whole point of the index is to answer "what's near X?" cheaply at query time without an LLM in the loop. This skill is for *enriching the curated edges*, run periodically (weekly / on demand), not on every search.
- **High-precision edge classification** (e.g., `supersedes`, `caused-by`) — those are typed edges per the edge taxonomy, requiring more nuanced judgment than `related-to`. A separate `/vault review-edges` skill covers that.

## Background

Why this works: BGE retrieval (chunked, CLS-pooled, see `[[projects/vault-storage/design/embedding-model]]`) achieves ~24× lift over random for R@10 on the live vault, but absolute precision is depressed by sparse curation. Each "false positive" at high cosine is often a *real* match that no human got around to writing into the source note's frontmatter. This skill captures those — the LLM judges which top-K candidates are genuine, and the curated set densifies. Subsequent eval runs against the densified ground truth produce both higher precision numbers (model finds more curated positives) and a more accurate picture of where the model genuinely lacks. See `[[projects/vault-storage/design/embedding-baseline]]` § PR sweep.
