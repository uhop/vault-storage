# Vault skills

Backup of the Claude Code skills used to drive vault-storage from inside an agent
session. They're shipped here so they can be reinstalled on a new machine and
copied as a starting template by anyone who runs their own vault-storage
instance.

These are **personal skills** with the author's conventions baked in. Read the
caveats below before installing — paths and assumptions may need substitution.

## What's in here

| Path                            | Purpose                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `skills/vault/`                 | The `/vault` master skill: ingest / learn / query / log / resume / check.                         |
| `skills/vault-check-drift/`     | Drift check between project state and the vault-recorded baseline. Used by `/vault resume`.       |
| `skills/vault-propose-related/` | Densify the knowledge graph by proposing missing `related:` cross-references using BGE retrieval. |
| `skills/vault-search/`          | Single-shot search against the vault (`POST /search/simple/`). Lexical + semantic.                |
| `skills/vault-similar/`         | Embedding nearest-neighbours of a record (`GET /sections/{id}/similar`). vault-storage only.      |
| `skills/vault-graph/`           | Typed-edge neighborhood walk (`GET /sections/{id}/neighborhood`). vault-storage only.             |
| `../bin/vault-curl`             | `curl` wrapper that prepends `$VAULT_API_URL` and the auth header. Required by all six skills.    |

### Known gap — `vault-lint`

The `/vault` skill describes a `/vault lint` subcommand and points at
`~/.claude/skills/vault-lint/vault-lint.sh`. **That skill does not exist in
this backup.** It's referenced but never implemented (or was deleted before
the backup). Treat that section as a TODO; the policy lives in the vault at
`topics/vault-hygiene-policy.md`.

## Caveats

- **Personal paths.** `vault-propose-related/SKILL.md` references
  `~/Open/vault-storage` in example commands. Substitute your own paths.
- **Wording.** The `/vault` skill describes the API surface in
  "Obsidian Local REST API" terms — that's how it was first written. The
  vault-storage server's Phase A REST surface is path-shape-compatible, so
  the same skill works against either backend with `$VAULT_API_URL` pointed
  at the right place.
- **`vault-check-drift/check-drift.sh`** is generic — uses `$VAULT_API_URL`
  via `vault-curl`, no hardcoded paths.

## Install

### 1. Set the connection env vars

In `~/.env` (sourced by `~/.bashrc` / `~/.zshrc`):

```bash
export VAULT_API_URL=http://your-host:8123
export VAULT_API_TOKEN=<bearer-token>
```

Generate a token with `openssl rand -hex 32` and put the same value in the
server's `.env` (see top-level README).

### 2. Copy the skills to user scope

From the root of this repo:

```bash
cp -r skills/vault skills/vault-check-drift skills/vault-propose-related skills/vault-search skills/vault-similar skills/vault-graph ~/.claude/skills/
```

Skills under `~/.claude/skills/` are user-scope — visible from every project.

### 3. Install `vault-curl` on `$PATH`

```bash
install -m 0755 bin/vault-curl ~/.local/bin/vault-curl
```

(Any directory on `$PATH` works — `~/.local/bin/`, `/usr/local/bin/`, etc.)

### Optional dependencies

- `jq` — required by `vault-check-drift/check-drift.sh`.
- `npm` — used by the drift check when a project has a registered npm package.

## MCP setup

The skills above hit the REST API directly through `vault-curl`. There is also
an MCP adapter (`mcp/` in this repo) that exposes the same surface to Claude
Code as ~20 tools and 3 resources, with closed-enum input schemas the agent
discovers automatically. Either path works; MCP gives the agent a richer
schema-aware experience, the curl path is the lowest-common-denominator
fallback.

### Project-scope (only this repo)

`.mcp.json.example` is committed at the repo root. To activate:

```bash
cp .mcp.json.example .mcp.json
$EDITOR .mcp.json    # fill in VAULT_API_URL + VAULT_API_TOKEN
```

`.mcp.json` is gitignored so secrets stay local. Restart Claude Code in this
directory; the first session prompts to approve the project-level MCP config.

### User-scope (every project on this machine)

```bash
claude mcp add --scope user vault \
  --env VAULT_API_URL=http://your-host:8123 \
  --env VAULT_API_TOKEN=<token> \
  -- node /path/to/vault-storage/mcp/src/index.ts
```

Lives in `~/.claude.json`; visible from every project on the machine.

### Standalone install (no checkout)

For machines where you don't want to clone `vault-storage`, use the install
script. It pulls the latest MCP tarball from this repo's GitHub Releases
(public — no auth needed), installs it under `~/.local/lib/vault-storage-mcp/`,
and drops a launcher at `~/.local/bin/vault-storage-mcp`:

```bash
curl -fsSL https://raw.githubusercontent.com/uhop/vault-storage/main/scripts/install-mcp.sh | sh
```

Pin a specific version (naked `0.0.1` or full `mcp-0.0.1` both work):

```bash
curl -fsSL https://raw.githubusercontent.com/uhop/vault-storage/main/scripts/install-mcp.sh | sh -s -- --version 0.0.1
```

Override the install root:

```bash
curl -fsSL https://raw.githubusercontent.com/uhop/vault-storage/main/scripts/install-mcp.sh | sh -s -- --prefix /opt/vault-mcp
```

Requirements: `node ≥ 25`, `npm`, `curl`, `tar`. The installer is idempotent
— re-run to upgrade.

After install, register with Claude Code:

```bash
claude mcp add --scope user vault \
  --env VAULT_API_URL=http://your-host:8123 \
  --env VAULT_API_TOKEN=<token> \
  -- ~/.local/bin/vault-storage-mcp
```

This is the recommended path for new machines.

### Verify

In a Claude Code session, `/mcp` should list `vault` connected with 20 tools
and 3 resources. Or hit the status tool directly:

```
mcp__vault__vault_status →
  schema_version: 3
  records: …
  edges: …
  pending_suggestions: …
```

The skills don't depend on the MCP — they call the REST API through
`vault-curl` regardless. MCP is an additive surface for the agent, not a
prerequisite.
