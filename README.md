# vault-storage

An AI-agent-first persistent knowledge base. Markdown files are the source of truth; a SQLite + `sqlite-vec` index sits next to them and provides fast lookup, semantic search, and typed-edge traversal for AI agents.

**Status:** v0.x, in active development. Working: importer, embedder, REST server (auth + section read/write), migration tool (Obsidian → vault-storage tree). Not yet: MCP layer, suggestions review surface, decay/maintenance jobs, Docker packaging.

## Architecture

- **Content** lives in a separate **private** git repo: [`vault-data`](https://github.com/uhop/vault-data). Plain markdown with YAML frontmatter, organized into `topics/`, `projects/`, `queries/`, `logs/`, `raw/`. This is the source of truth.
- **Index** is SQLite + [`sqlite-vec`](https://github.com/asg017/sqlite-vec), accessed via the built-in `node:sqlite`. The DB is fully derivable from the content repo; on total DB loss, a rebuild from `git clone` works.
- **Server** is Node 25 + TypeScript on `node:http`, with bearer-token auth on every endpoint. Speaks REST today; MCP layer (for Claude Code et al.) is planned.
- **Embeddings** are `Xenova/bge-small-en-v1.5` (384-dim float32, CLS pooling, paragraph-overlapped chunking, ONNX via `@huggingface/transformers`, runs on local CPU).
- **Sync between machines** is `git pull` / `git push` against `vault-data`. Per-machine local DB; per-user state stays local; shared content syncs via git.

## Repositories

| Repo                                                                 | Visibility  | Purpose                           |
| -------------------------------------------------------------------- | ----------- | --------------------------------- |
| [`vault-storage`](https://github.com/uhop/vault-storage) (this repo) | public      | server code                       |
| [`vault-data`](https://github.com/uhop/vault-data)                   | **private** | markdown content, source of truth |

The split keeps this code repo public (so it can be installed and inspected) without exposing personal notes.

## Setup

Requires Node ≥ 25.

```bash
git clone git@github.com:uhop/vault-storage
cd vault-storage
npm install

# Clone the content repo somewhere; this becomes VAULT_DATA_PATH.
git clone git@github.com:uhop/vault-data /path/to/vault-data
```

Environment variables:

| Variable            | Required | Purpose                                                                      |
| ------------------- | -------- | ---------------------------------------------------------------------------- |
| `VAULT_DATA_PATH`   | yes      | Markdown content tree (the `vault-data` clone). Source of truth.             |
| `VAULT_API_TOKEN`   | yes      | Bearer token enforced on every server request.                               |
| `VAULT_DB_PATH`     | no       | SQLite path. Default `${VAULT_DATA_PATH}/.vault-storage/vault.sqlite`.       |
| `VAULT_HOST`        | no       | Bind address. Default `127.0.0.1`.                                           |
| `VAULT_PORT`        | no       | Listen port. Default `8123`.                                                 |
| `VAULT_INGEST_PATH` | no       | Default source path for `migrate` / `import` subcommands.                    |
| `VAULT_EMBEDDER`    | no       | Set to `fake` to skip BGE model load (dev/test only).                        |

Put these in `~/.env` (sourced by `.bashrc`) or pass on the command line.

## Usage

### Run the server

```bash
VAULT_DATA_PATH=/path/to/vault-data \
VAULT_API_TOKEN=<token> \
  npm start
```

Server listens on `${VAULT_HOST}:${VAULT_PORT}` (default `127.0.0.1:8123`).

### REST endpoints (current surface)

All endpoints require `Authorization: Bearer <token>`.

| Method | Path                       | Purpose                                                            |
| ------ | -------------------------- | ------------------------------------------------------------------ |
| GET    | `/system/status`           | Schema version, record / edge / suggestion counts.                 |
| GET    | `/sections`                | List records. Filters: `type`, `status`, `file_path`, `file_prefix`, `priority_min/max`, `updated_since`, `record_ids`. Pagination: `offset`, `limit` (max 100). |
| GET    | `/sections/{record_id}`    | Read a record by ID. `?exclude=body` for a meta-only fetch.        |
| GET    | `/sections/{record_id}/meta` | Frontmatter projection only (no body).                           |
| PUT    | `/sections/{record_id}`    | Replace body (`Content-Type: text/markdown`). Frontmatter-aware: user keys merged, auto-managed keys rejected. |

More endpoints (search, edges, suggestions) are coming with the MCP layer.

### CLI subcommands

```bash
node src/index.ts info                           # DB version + record count
node src/index.ts import <vault-path>            # import a directory + embed
node src/index.ts migrate <source> <target>     # transform Obsidian vault → vault-storage tree
node src/index.ts serve                          # start the REST server (= `npm start`)
```

The `migrate` subcommand:

- Remaps legacy status (14 values) → 5-value closed enum.
- Remaps legacy type (`decision` → `design`, `learning` → `research`, etc.).
- Canonicalizes tags (lowercase, kebab-case, ASCII; conservative singular/plural collapse).
- Backfills frontmatter for files that lack it.
- Atomizes oversized files (> 30 KB AND > 5 top-level sections) into per-section pieces.
- Seeds `tags_taxonomy` + `tag_aliases` from the canonicalized tag corpus.

After `migrate`, run `import` against the target tree to build records, edges, and embeddings.

## Tests

```bash
npm test         # tape-six suite
npm run ts-check # tsc --noEmit
```

Currently 425+ asserts across ~200 tests covering importer, classifier, server, migration, and atomization paths.

## Design summary

The architectural decisions are recorded as numbered constraints C1–C16 in the design vault. The shapes that matter for using the project:

- **Files = source of truth.** DB is a derived index. `cat`, `vim`, `grep`, Obsidian all keep working against the content repo.
- **Atomization splits big running files into per-section pieces at migration time.** Each piece becomes its own record with inherited frontmatter and a folder-level `_about.md`.
- **Frontmatter is indexer-managed.** Body is authored; indexer derives `tags`, `type`, `status`, `created`, `updated`. User-authored fields are reconciled, not overwritten.
- **Agent-driven intelligence.** No LLM calls inside the indexer. Heuristics produce suggestions; agents review them through dedicated commands. Cost is paid by the agent loop, not by background pipelines.
- **Closed enums.** `status` (5 values), `type` (14 values), edge types (10), suggestion kinds (8). Enforced by SQLite CHECK constraints.
- **Two-tier backup.** Tier 1 (required): `git push` of `vault-data`. Tier 2 (optional, off by default): `vault.sqlite` snapshot to S3 with object versioning.

## License

TBD
