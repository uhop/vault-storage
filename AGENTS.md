# vault-storage — AI Agent Rules

## Project identity

vault-storage is an AI-agent-first knowledge base **server**: markdown files (in the separate, private `vault-data` repo) are the source of truth, and a SQLite + `sqlite-vec` index next to them provides fast lookup, lexical (FTS5) + semantic (BGE embeddings) search, and typed-edge traversal behind a bearer-token REST API on `node:http`. The `mcp/` sub-package adapts the REST surface to MCP for Claude Code. Deployed via Docker Compose; also runs bare on Node ≥ 26 (a lifecycle floor — Node 25 is EOL — not a feature floor). This is an application, not a library: nothing here is imported by downstream code, and there is no npm publish of the server itself.

## Critical rules

- **TypeScript under Node type-stripping — erasable syntax only.** `.ts` files run directly (`node src/index.ts`); there is no build step and no `tsc` emit. Forbidden (they emit runtime code): `enum`, `namespace` with values, parameter properties (`constructor(public x: number)`), decorators, `import x = require(...)`, JSX. Use `as const` arrays + `(typeof ARR)[number]` unions instead of enums (pattern in `src/records/types.ts`). `tsconfig.json` enforces this via `erasableSyntaxOnly` + `isolatedModules`.
- **Markdown files are the source of truth; the DB is a derived index.** Never treat SQLite state as authoritative — the DB must stay fully reconstructable from the vault tree plus an embedding pass.
- **No LLM calls inside the indexer.** Heuristics file suggestions; agents review them through dedicated commands. Cost is paid by the agent loop, not by background pipelines.
- **Closed enums** (`status`, `type`, edge types, suggestion kinds) are enforced by SQLite CHECK constraints — changing them is a schema migration, not an edit.
- **Schema migrations are append-only** numbered SQL files in `src/db/schema/`. A migration that rebuilds the `records` table must drop + recreate + `'rebuild'` the FTS5 external-content index — its rowid linkage breaks silently otherwise.
- **Broken 3rd-party types → `skipLibCheck`**, never local `.d.ts` shims or `patch-package` (shims silently shadow upstream fixes).
- **Double-casts preserve shape**: `stmt.all() as unknown[] as T[]`, not `as unknown as T[]`.
- **README.md stays current**: any change to setup, env vars, endpoints, or usage updates the affected README section in the same change.

## Code style

- Prettier: 100 char width, single quotes, no bracket spacing, no trailing commas, arrow parens "avoid".
- 2-space indentation (`.editorconfig`).
- **No comments that narrate the code.** Don't write a comment that restates _what_ the code does. Allowed, each as the shortest possible marker: JSDoc when requested or required; a reference for a non-trivial algorithm; a non-trivial _decision_ or constraint — _why_ it's this way, including footgun/ordering caveats that have a real reason. The bar is _why_, never _what_. Strip narrating comments opportunistically in files you're already editing.

## Architecture quick reference

Start with `ARCHITECTURE.md` for the full module map. The coarse shape:

- **`src/index.ts`** — CLI entry: `info`, `import`, `migrate`, `serve` subcommands.
- **`src/server/`** — `node:http` server: router, bearer auth, handlers (REST surface), file-watcher with debounced reindex, git auto-commit loop, snapshot mechanics, the JSON/markdown write path with frontmatter validation.
- **`src/importer/`** — file → record pipeline: frontmatter parse, tag import, wikilink classification, typed-edge build, suggestion filing.
- **`src/embeddings/`** — BGE (ONNX, local CPU) and fake embedders behind one interface; paragraph-overlapped chunker; embed pass.
- **`src/db/`** — `node:sqlite` connection (+ `sqlite-vec` extension), numbered schema migrations, vector repos.
- **`src/records/`**, **`src/queue/`** — record/edge repositories and the queue-items derivative synced from `queue.md` files.
- **`src/maintenance/`** — scans (duplicates, compaction, retention, upgrade signals), lint cleanup, incremental reindex, raw inbox.
- **`src/migration/`** — one-time Obsidian-vault → vault-storage tree transform (atomization, tag canonicalization, frontmatter backfill).
- **`mcp/`** — plain-JS MCP adapter over the REST API (own package, tests, GitHub-release tarball distribution).
- **`static/ui/`** — light dashboard/editor UI served by the server.
- **`skills/`** — Claude Code vault skills (install instructions in `skills/README.md`).

## Dependencies

Runtime dependencies are deliberately few (fleet minimal-dependencies policy); justify any addition:

- **`@huggingface/transformers`** — ONNX inference for BGE embeddings (local CPU).
- **`sqlite-vec`** — vector-search SQLite extension loaded into `node:sqlite`.
- **`time-queues`** — scheduling for the watcher / git-sync / scan loops.
- **`yaml`** — frontmatter parse + safe serialization.
- **Dev only:** `tape-six` (tests), `prettier` (formatting), `typescript` + `@types/node` (`ts-check`, no emit).

## Verification commands

- `npm test` — tape-six suite. Most tests use in-memory SQLite + the fake embedder; `tests/test-bge-embedder.ts` exercises the real model (first run downloads ~33 MB into the transformers cache, then cached).
- `npm run ts-check` — `tsc --noEmit` (strict; `erasableSyntaxOnly` re-verifies the no-runtime-TS rule).
- `npm run lint` / `npm run lint:fix` — Prettier check / write.
- `cd mcp && npm test` — MCP adapter suite.

## Tests

- tape-six; the canonical idiom guide is tape-six's own `write-tests` skill (`node_modules/tape-six/TESTING.md` after install).
- Shared per-test setup uses `t.beforeEach` / `t.afterEach` with in-memory DB + repos (pattern in `tests/test-records-repository.ts`, `tests/test-importer.ts`).
- Matchers: `t.match()` for partial object matching, `t.matchString()` for string-vs-regex; `t.throws` / `t.rejects` accept matchers.

## File layout

- Server source: `src/` (TypeScript, run directly — no build)
- MCP adapter: `mcp/` (plain JS sub-package)
- Tests: `tests/test-*.ts`; MCP tests: `mcp/tests/`
- UI: `static/`
- Vault skills: `skills/`
- Embedding eval harness: `eval/`
- Operational scripts: `bin/` (update.sh, vault-curl), `scripts/` (install-mcp.sh)

## When reading the codebase

- Start with `ARCHITECTURE.md` for the module map and data flow.
- `README.md` documents the operational surface: env vars, REST endpoints, backup tiers, multi-writer git-as-sync.
- Design constraints and decision records live in the vault (`projects/vault-storage/`), not in this repo.
