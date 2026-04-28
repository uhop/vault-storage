# vault-storage

An AI-agent-first persistent knowledge base. Markdown files are the source of truth; a SQLite + `sqlite-vec` index sits next to them and provides fast lookup, semantic search, and typed-edge traversal for AI agents.

**Status:** design locked 2026-04-27, implementation pending. The full design lives in a private vault; the short version is below.

## Architecture

- **Content** lives in a separate **private** git repo: [`vault-data`](https://github.com/uhop/vault-data). Plain markdown with YAML frontmatter, organized into `topics/`, `projects/`, `queries/`, `logs/`, `raw/`. This is the source of truth.
- **Index** is SQLite + [`sqlite-vec`](https://github.com/asg017/sqlite-vec), accessed via the built-in `node:sqlite`. The DB is fully derivable from the content repo; on total DB loss, a rebuild from `git clone` works.
- **Server** is Node 25 + TypeScript + Koa, bearer-token auth on every endpoint. Speaks REST for direct use and MCP for AI agents (Claude Code etc.).
- **Embeddings** are `Xenova/bge-small-en-v1.5` (384-dim float32, ONNX via `transformers.js`, runs on local CPU).
- **Sync between machines** is `git pull` / `git push` against `vault-data`. Per-machine local DB; per-user state stays local; shared content syncs via git.

## Repositories

| Repo                                                                 | Visibility  | Purpose                           |
| -------------------------------------------------------------------- | ----------- | --------------------------------- |
| [`vault-storage`](https://github.com/uhop/vault-storage) (this repo) | public      | server code                       |
| [`vault-data`](https://github.com/uhop/vault-data)                   | **private** | markdown content, source of truth |

The split keeps this code repo public (so it can be installed and inspected) without exposing personal notes.

## Setup

> Code is not yet implemented. This section will fill in as features land.

Planned shape:

1. Clone this repo.
2. Provision an SSH deploy key with read/write access to `vault-data` and clone it next to (or inside) this repo.
3. Create `.env` with `VAULT_API_TOKEN`, `VAULT_DATA_PATH`, optional `BACKUP_S3_BUCKET` (Tier 2 backup).
4. `docker compose up` to start the server + scheduled-jobs container.
5. Run the one-shot importer to build the initial DB from `vault-data`.

## Usage

> Not yet implemented. Will cover:
>
> - REST surface: search (lexical / semantic / hybrid), section CRUD, edges, suggestions, tags, maintenance jobs.
> - MCP surface: ~25 tools, 5 resources, 8 prompts (replacing today's `~/.claude/skills/vault/SKILL.md` slash commands).
> - CLI commands invoked via the agent: `/vault compact`, `/vault review-edges`, `/vault review-duplicates`, `/vault review-tags`.

## Design summary

The architectural decisions are recorded as numbered constraints C1–C16 in the design vault. The shapes that matter for using the project:

- **Files = source of truth.** DB is a derived index. `cat`, `vim`, `grep`, Obsidian all keep working against the content repo.
- **Sections-as-records.** The unit of record is a markdown section, keyed by header path — not the file. Reads return relevant sections, not whole files. Atomization splits today's bloated files into per-record pieces at import.
- **Frontmatter is indexer-managed.** Body is authored; indexer derives `tags`, `type`, `status`, `created`, `updated`. User-authored fields are reconciled, not overwritten.
- **Agent-driven intelligence.** No LLM calls inside the indexer. Heuristics produce suggestions; agents review them through dedicated commands. Cost is paid by the agent loop, not by background pipelines.
- **Closed enums.** `status` (5 values), `type` (14 values), edge types (10), suggestion kinds (8). Enforced by SQLite CHECK constraints.
- **Two-tier backup.** Tier 1 (required): `git push` of `vault-data`. Tier 2 (optional, off by default): `vault.sqlite` snapshot to S3 with object versioning.

## License

TBD
