# vault-storage — Architecture

AI-agent-first knowledge base over a markdown tree. The markdown files (the private `vault-data` repo) are the source of truth; SQLite + `sqlite-vec` next to them is a fully rebuildable derived index providing lexical (FTS5) + semantic (BGE) search and typed-edge traversal behind a single-process `node:http` REST server. TypeScript throughout `src/`, run directly under Node type-stripping — no build step.

## Data flow

```
markdown tree (source of truth)
  → walk / importFile   → records (+ tags, chunks)
  → buildEdges          → edges (+ review suggestions)
  → embedPending        → record_vec / record_doc_vec
```

Reads go through REST handlers over the repositories plus `sqlite-vec` KNN and FTS5. Writes-in (`PUT /vault/{path}`, `PUT /sections/{id}`) land on disk first, then re-import inline. Background loops keep everything converged: the watcher (disk → DB), git-sync (tree → commits), the scan scheduler (periodic maintenance → suggestions), and incremental reindex (post-`git pull`). The MCP adapter and the static UI are pure REST clients.

## Entry points

- **`src/index.ts`** — CLI dispatcher: `info` (schema/record counts), `import` (importVault + embedPending), `migrate` (one-time Obsidian tree transform), `serve` (delegates to the server's `main()`). `makeEmbedder()` picks `BgeEmbedder` or `FakeEmbedder` via `VAULT_EMBEDDER`.
- **`src/server/index.ts`** — composition root: env, DB open + migrations, embedder, optional startup reindex, then server + watcher + memory reporter + git-sync + scan scheduler; SIGINT/SIGTERM graceful shutdown.
- **`src/server/server.ts`** — `buildRouter()` registers every route against shared repositories; request pipeline: URL parse → `OPTIONS` (pre-auth method discovery) → bearer-auth gate (`/ui/*`, `/favicon.ico` public) → route match → handler.
- **`src/server/router.ts`** — regex router; `{id}` → `([^/]+)`, `{path}` → `(.+)`. Registration order is precedence — literal routes before wildcards.

## Import pipeline (`src/importer/`)

- **`import.ts`** — `importVault`: one transaction over `walkMarkdown` → per-file `importFile`, then `buildEdges`.
- **`import-file.ts`** — per-file stage: frontmatter parse, type/status/priority/date derivation, `agent:` block extraction, content hashes; skips unchanged files (hash + FM compare — dates at date granularity, see decision D3); files/auto-resolves `tag_suggestion` / `agent_enrichment_stale` / `archive_candidate`.
- **`walk.ts`** — recursive `.md` walker (skips `.git`, `node_modules`, `.obsidian`).
- **`type-from-path.ts`** — folder-default record-type inference (`_index.md` → index, `projects/*/state.md` → state, …).
- **`import-tags.ts`** — normalize + alias-rewrite FM tags, replace the record's tag set atomically; unknown tags file `new_tag` suggestions.
- **`build-edges.ts`** — second pass: FM `related:`/`edges:` + body wikilinks → resolved typed edges, stale-edge pruning, `edge_type` review suggestions.
- **`classify-wikilinks.ts`** — heuristic edge classifier for body links (keyword cues; default `cites`).
- **`resolver.ts`** — wikilink target → record id (exact path, `.md`-stripped, unique basename, `_about.md` fallback).
- **`file-suggestions.ts`** — generic `SuggestionFiler` with per-kind idempotency and snooze semantics.

## Embeddings (`src/embeddings/`)

- **`types.ts`** — the `Embedder` interface.
- **`bge.ts`** — `Xenova/bge-small-en-v1.5` (384-dim, CLS-pool, L2-norm) via `@huggingface/transformers` ONNX on CPU; held by a `time-queues` Retainer that frees the ~GB arena after idle; `maxBatch` sub-batching; NaN-vector retry + logging.
- **`fake.ts`** — deterministic sha256-seeded unit vectors; used by tests and `VAULT_EMBEDDER=fake`.
- **`chunker.ts`** — markdown-aware chunking: header-path prefixes, paragraph/char overlap, optional `agent.summary` prefix (HyDE anchor).
- **`embed-pass.ts`** — `embedPending`: re-embeds records whose content hash drifted; batch-embeds outside the transaction, writes per batch.
- **`anomaly-log.ts`** — append-only JSONL log of non-finite-vector events.

Vector storage: **`src/db/vec-repo.ts`** (per-chunk vectors, KNN via per-record MIN chunk distance) and **`src/db/doc-vec-repo.ts`** (one mean-pooled vector per record; drives duplicate detection).

## DB layer (`src/db/`)

- **`connection.ts`** — `node:sqlite` `DatabaseSync` + `sqlite-vec` extension, `sha256_hex` SQL function, FK enforcement, WAL.
- **`migrate.ts`** — applies `schema/NNNN_*.sql` in numeric order, each in its own transaction (`-- migrate:no-transaction` opt-out for table rebuilds).
- **`schema/`** — append-only numbered migrations (`0001_init.sql` …). Notable: 0004 doc-vecs, 0005/0006 agent enrichment, 0008 queue_items, 0013 FTS5 lexical index. A migration that rebuilds `records` must drop + recreate + `'rebuild'` the FTS5 external-content index.
- **`meta.ts`** — typed KV: `schema_version`, `last_indexed_commit`, `content_generation`, git-sync failure ledger.

## Server surface (`src/server/handlers/`)

- **`records.ts`** — `GET /sections` (list/filter/paginate), record reads, FM PATCH, tag membership endpoints.
- **`records-write.ts`** — `PUT /sections/{id}`: write to disk at the record's path, re-import inline.
- **`vault.ts`** — path-addressed content API: `GET/PUT/DELETE /vault/{path}`, folder listing, `POST /vault/move|supersede|propose`.
- **`search.ts`** — `POST /search/simple`: FTS5 bm25 + title boost (lexical) blended with chunk-KNN (semantic).
- **`similar.ts`**, **`edges.ts`** — nearest-neighbour records; typed-edge neighborhood (depth ≤ 5) + backlinks.
- **`suggestions.ts`** — the agent review queue: list/summary/accept/reject/reopen.
- **`tags.ts`** — taxonomy + aliases + per-tag records.
- **`maintenance.ts`** — `POST /maintenance/*`: scans (duplicates, compaction, retention, upgrade signals), cleanups, embed-pending, incremental reindex, snapshots, raw inbox.
- **`queue.ts`** — queue-item slices (top, by-section, by-priority, per-project).
- **`system.ts`**, **`lint.ts`** — status; integrity checks + enrichment-coverage block (see decisions D4/D5).
- **`commit.ts`**, **`resolve.ts`**, **`static.ts`** — explicit git commit; wikilink resolution; UI file serving.

Background/lifecycle modules in `src/server/`: **`git-sync.ts`** (auto-commit loop with backoff and stale-lock recovery), **`watcher.ts`** (debounced `fs.watch` → incremental import/delete/embed), **`writer.ts`** (the disk-write + FM-validation core: auto-managed keys, closed-enum validation, ETag), **`snapshot.ts`** (`VACUUM INTO` gzip snapshots for Tier-2 backup). Support: `env.ts`, `auth.ts` (constant-time bearer check), `body.ts`, `query.ts`, `responses.ts`, `serialize.ts`, `resolver-cache.ts`, `memory-reporter.ts`.

## Other modules

- **`src/records/`** — closed-enum types (`types.ts`), `RecordsRepository` / `EdgesRepository`, lazy decay scoring.
- **`src/queue/`** — parse `queue.md` / `queue-archive.md` into `queue_items` rows; watcher glue + full reindex.
- **`src/maintenance/`** — the find-\* scans, lint cleanups, incremental reindex, run-all bundle, scan scheduler, search-before-write propose, raw-inbox classification, doc-vec backfill.
- **`src/markdown/`** — YAML frontmatter parse/serialize; wikilink extraction with code-region masking.
- **`src/migration/`** — one-time Obsidian → vault-storage transform: enum remaps, tag canonicalization, frontmatter backfill, oversized-file atomization, taxonomy seeding.
- **`src/util/`** — git spawn wrapper, content/embed-input hashing, UUIDv7 ids.

## mcp/ subpackage

Standalone stdio MCP ↔ REST adapter (plain JS, no local state), distributed as a GitHub-release tarball (`mcp-*` tags) installed by `scripts/install-mcp.sh`:

- **`src/index.js`** — entry: env (`VAULT_API_URL`, `VAULT_API_TOKEN`), `McpServer` over stdio, tool + resource registration.
- **`src/client.js`** — fetch wrapper adding base URL + bearer, error normalization.
- **`src/tools.js`** — 30 tools (one per REST endpoint) with zod schemas mirroring the server's closed enums.
- **`src/resources.js`** — 3 read-only resources: `vault://status`, `vault://suggestions/pending`, `vault://taxonomy/tags`.

## static/ UI

Vanilla-JS page set under `static/ui/` (public shell; API calls carry the user's bearer from localStorage): dashboard, search, note editor, folder/projects/tags/raw browsers, archive + lint review pages; shared `api.js`, theme, `vault-editor` / `vault-markdown` web components, vendored `marked`.

## Tests

~65 `tests/test-*.ts` files on tape-six. Standard pattern: in-memory SQLite, `FakeEmbedder`, config passed as literal objects (no `VAULT_*` env reads); server tests bind a real HTTP server on loopback. `tests/test-bge-embedder.ts` is the one non-hermetic test — it loads the real model (~33 MB download on a cold cache). Three tests shell out to the real `git` binary.

## bin/, scripts/, skills/, eval/

- **`bin/update.sh`** — update a deployed instance; **`bin/vault-curl`** — authenticated curl wrapper for the REST API.
- **`scripts/install-mcp.sh`** — checkout-free MCP installer; `scripts/probe-unresolved.ts`, `scripts/scan-promotable-edges.ts` — one-off DB probes.
- **`skills/`** — Claude Code vault skills (see `skills/README.md`).
- **`eval/`** — retrieval-quality harnesses over an imported DB: baseline report, `agent.summary`-prefix A/B, related-candidate proposals, alternate-model trials.
