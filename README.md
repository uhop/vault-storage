# vault-storage

An AI-agent-first persistent knowledge base. Markdown files are the source of truth; a SQLite + `sqlite-vec` index sits next to them and provides fast lookup, semantic search, and typed-edge traversal for AI agents.

**Status:** v0.x, in active development. Working: importer, embedder, REST server (full path-based vault surface + insight reads + suggestions queue + Obsidian sync), MCP adapter (20 tools / 3 resources), file-watcher with auto-reindex, edge GC, auto-commit, migration tool (Obsidian → vault-storage tree), Docker packaging. Not yet: suggestions review surface, decay/maintenance jobs.

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

## Quick start (Docker)

```bash
git clone https://github.com/uhop/vault-storage
cd vault-storage
cp .env.example .env
# Edit .env: set VAULT_API_TOKEN and VAULT_DATA_PATH_HOST.
docker compose up -d
docker compose logs -f vault-storage   # watch the initial reindex
```

That's it. The container watches `VAULT_DATA_PATH_HOST` for markdown changes and keeps the index in sync. By default it listens on `0.0.0.0:8123` so other machines on your network can reach it (bearer-token auth required on every request — generate one with `openssl rand -hex 32`).

To restrict to local-only or LAN access, set `VAULT_PUBLISH_HOST=127.0.0.1` (or your LAN IP) in `.env`. For TLS over the public internet, put a reverse proxy (Caddy / nginx / Cloudflare Tunnel) in front, or use Tailscale/WireGuard for private remote access.

### Updating

```bash
bin/update.sh
```

Pulls the latest code, warns about new keys in `.env.example` that you haven't added to `.env`, builds an image tagged with both `:latest` and the short commit SHA, and recreates the container. To roll back, retag a previous SHA as `latest`:

```bash
docker tag vault-storage:<prev-sha> vault-storage:latest && docker compose up -d
```

Schema migrations apply automatically on container start.

## Setup (without Docker)

Requires Node ≥ 25.

```bash
git clone https://github.com/uhop/vault-storage
cd vault-storage
npm install

# Clone the content repo somewhere; this becomes VAULT_DATA_PATH.
git clone git@github.com:uhop/vault-data /path/to/vault-data
```

Environment variables:

| Variable                   | Required | Purpose                                                                      |
| -------------------------- | -------- | ---------------------------------------------------------------------------- |
| `VAULT_DATA_PATH`          | yes      | Markdown content tree (the `vault-data` clone). Source of truth.             |
| `VAULT_API_TOKEN`          | yes      | Bearer token enforced on every server request.                               |
| `VAULT_DB_PATH`            | no       | SQLite path. Default `${VAULT_DATA_PATH}/.vault-storage/vault.sqlite`.       |
| `VAULT_HOST`               | no       | Bind address. Default `127.0.0.1` (use `0.0.0.0` for remote access).         |
| `VAULT_PORT`               | no       | Listen port. Default `8123`.                                                 |
| `VAULT_INGEST_PATH`        | no       | Default source path for `migrate` / `import` subcommands.                    |
| `VAULT_EMBEDDER`           | no       | `bge` (default) or `fake` (skip model load — dev/test only).                 |
| `VAULT_AUTO_REINDEX`       | no       | Run a full reindex on startup. Default `true`.                               |
| `VAULT_AUTO_WATCH`         | no       | Watch the vault tree and reindex incrementally. Default `true`.              |
| `VAULT_WATCH_DEBOUNCE_MS`  | no       | Watcher debounce window. Default `1500`.                                     |
| `VAULT_AUTO_COMMIT`        | no       | Periodic `git add && git commit` of the vault tree. Default `true`.          |
| `VAULT_AUTO_PUSH`          | no       | `git push` after each auto-commit. Default `false` (manual push).            |
| `VAULT_COMMIT_INTERVAL_MS` | no       | Poll interval for auto-commit. Default `60000`.                              |
| `VAULT_GIT_AUTHOR_NAME`    | no       | Author name for auto-commits. Default `vault-storage`.                       |
| `VAULT_GIT_AUTHOR_EMAIL`   | no       | Author email for auto-commits. Default `vault-storage@localhost`.            |
| `VAULT_EMBED_ANOMALY_LOG`  | no       | JSONL path for transient-NaN embedding events. Default `${VAULT_DATA_PATH}/.vault-storage/embed-nan.jsonl`. Empty disables file logging (stderr-only). |

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
| GET    | `/system/lint`             | Integrity checks (bug-finding): embedding hash drift, missing/orphan embeddings, temporal anomalies, dangling tag aliases. Returns `{ok, total_issues, checks}`. ~50ms; safe on session-start flows. |
| GET    | `/sections`                | List records. Filters: `type`, `status`, `file_path`, `file_prefix`, `priority_min/max`, `updated_since`, `record_ids`. Pagination: `offset`, `limit` (max 100). |
| GET    | `/sections/{record_id}`    | Read a record by ID. `?exclude=body` for a meta-only fetch.        |
| GET    | `/sections/{record_id}/meta` | Frontmatter projection only (no body).                           |
| PUT    | `/sections/{record_id}`    | Replace body (`Content-Type: text/markdown`). Frontmatter-aware: user keys merged; `created`/`updated` accepted but indexer-overridden; DB-only keys (`record_id`, `content_hash`, `last_referenced`, `decay_score`) rejected. |

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

## Agent integration

Two complementary surfaces for driving the vault from inside a Claude Code
session:

- **Claude Code skills** — `skills/vault*` are the slash-command skills
  (`/vault resume`, `/vault check`, `/vault propose-related`, etc.) that hit
  the REST API directly through the `bin/vault-curl` wrapper. Backup +
  install instructions in [`skills/README.md`](skills/README.md).
- **MCP adapter** — the `mcp/` sub-package exposes the REST surface to Claude
  Code as ~20 tools and 3 resources with closed-enum input schemas. See
  `.mcp.json.example` for project-scope activation; `skills/README.md` covers
  user-scope setup. A standalone, checkout-free installer (release tarball +
  `curl | sh`) is in progress.

The two stack: skills can call the MCP tools, or fall back to `vault-curl`
when MCP isn't configured. Both share the same backend.

## Backup

Two-tier strategy:

**Tier 1 (default on):** every dirty markdown file is auto-committed by
the in-server git-sync loop (`VAULT_AUTO_COMMIT=true`, default). Optional
`VAULT_AUTO_PUSH=true` to also push to the configured remote. The
content tree (markdown + frontmatter) is fully recoverable from any clone.

**Tier 2 (optional):** `vault.sqlite` snapshot for DB-only state — the
suggestions queue, embeddings, `last_referenced` timestamps. The server
exposes a snapshot mechanic; the host wires the offsite shipment.

```bash
# In-container: produce a gzip-compressed snapshot. Default destination:
# ${VAULT_DATA_PATH}/.snapshots/vault.sqlite.gz (under the bind-mount).
curl -X POST -H "Authorization: Bearer $VAULT_API_TOKEN" \
  http://localhost:8123/maintenance/snapshot
```

```bash
# Host-side cron, daily 03:30: snapshot then ship via whatever upload
# tool you have on hand. The vault-data tree is bind-mounted on the
# host, so the snapshot file lands at a path the host can read directly.
30 3 * * * \
  curl -fsS -X POST -H "Authorization: Bearer $TOKEN" \
       http://localhost:8123/maintenance/snapshot && \
  aws s3 cp /media/raid/Vault-Data/.snapshots/vault.sqlite.gz \
            s3://${YOUR_BUCKET}/vault-storage/vault.sqlite.gz
```

Use `rclone`, `rsync`, or any encryption-aware wrapper instead of
`aws s3 cp` as preferred. Encryption keys, credentials, and the upload
tool all live on the host — none enter the container. Bucket-level
versioning preserves history at no application cost.

```bash
# Retention: list and prune. Server provides the mechanic; host orchestrates
# the policy (age threshold, count cap, etc).
curl -fsS -H "Authorization: Bearer $TOKEN" \
     http://localhost:8123/maintenance/snapshot-list
# → {snapshots: [{name, bytes, mtime}, …], totalBytes}

curl -fsS -X DELETE -H "Authorization: Bearer $TOKEN" \
     "http://localhost:8123/maintenance/snapshot?name=vault-2025-12.sqlite.gz"
# → 204
```

`GET /maintenance/snapshot-download?name=…` streams a snapshot file for
offline inspection. Bare filenames only — no path separators, no traversal.

## Multi-writer (git-as-sync)

The vault-data tree is a normal git repo. Multiple machines can each
run their own vault-storage instance against the same shared remote;
synchronization is via `git pull` / `git push`, not the application
layer. Each machine maintains its own local SQLite (the DB is a
derived index — reconstructable from files in O(records) embed time).

After a `git pull` lands new commits on a non-primary machine, the
local DB lags. Bring it up to date with the incremental reindex:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" \
     http://localhost:8123/maintenance/incremental-reindex
```

It diffs `meta.last_indexed_commit..HEAD`, dispatches per-file:
- modified / added → re-imports through the normal pipeline (tags,
  agent block, suggestions, edges)
- deleted → drops the row
- renamed → preserves `record_id` by updating the path key

If the recorded anchor is no longer in HEAD's ancestry (force-push,
rebase) the call falls back to a full `importVault` and re-pins HEAD.
Force a full reindex any time with `?full=true`.

Merge conflicts are the user's responsibility — resolve via standard
git, then run incremental reindex. The model is "git is the
synchronization layer; the DB is per-machine derivative state."

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

BSD-3-Clause. See [LICENSE](LICENSE).
