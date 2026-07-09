---
name: vault
description: 'Read and write to the knowledge base vault. Use when the user says /vault, asks to remember/save knowledge, wants to recall/query stored knowledge, asks to extract learnings from a project, or wants to log a session. Also use proactively at session end to capture non-obvious learnings.'
user_invocable: true
---

# Knowledge Base

Persistent knowledge base, accessed via a REST API (vault-storage). The LLM writes and maintains all content.

## Connection

Requires two environment variables (set in `~/.env`, which is sourced by `.bashrc`):

- `VAULT_API_URL` — base URL of the vault REST API (vault-storage; e.g., `http://host:8123`)
- `VAULT_API_TOKEN` — bearer token for authentication

### Use `vault-curl` — don't hand-roll `curl`

There is a `vault-curl` wrapper on `$PATH` (installed under `~/.local/bin/vault-curl`). **Prefer it over raw `curl`** — it prepends `$VAULT_API_URL` and the `Authorization: Bearer $VAULT_API_TOKEN` header, checks the env vars, and forwards every remaining flag straight to `curl`.

Quick check before the first vault op in a session:

```bash
command -v vault-curl >/dev/null || { echo "vault-curl missing — falling back to curl"; }
```

`vault-curl` itself exits with a clear error if `VAULT_API_URL` or `VAULT_API_TOKEN` is unset, so no separate guard is required. Only fall back to raw `curl` if `vault-curl` isn't installed on the machine.

**Never grep dotfiles for the credentials.** `vault-curl` resolves `VAULT_API_URL` / `VAULT_API_TOKEN` from the already-sourced env (`~/.env` via `.bashrc`). If a call fails for missing creds, report it — do **not** scan `~/.bashrc` / `~/.env` / other dotfiles to find them. The auto-mode classifier flags systematic dotfile credential-scanning as Credential Exploration and denies it (correctly).

API endpoints (invoked via `vault-curl <path> [curl-options...]`):

- **Read**: `vault-curl /vault/{path} -s`
- **Write (JSON — THE write path)**: `vault-curl /vault/{path} -X PUT -H 'Content-Type: application/json' --data-binary @payload.json`
  - Body shape: `{"frontmatter": {...}, "body": "..."}` — the server takes the FM object directly, skips YAML parse, and serializes safely (auto-quoting colon-space, leading-special-char, hex/bool/date-shadow strings). Always use this when authoring or modifying frontmatter values.
  - Construct the payload with `jq` and `--rawfile` to safely embed a body that contains arbitrary characters — write scratch under a `WORK=$(mktemp -d)` dir, not a hardcoded `/tmp` name (CLAUDE.md § "Scratch files"): `jq --null-input --rawfile body "$WORK/body.md" '{frontmatter: {title: "X", ...}, body: $body}' > "$WORK/payload.json"`.
  - **Prose FM values (`title`, `agent.summary`) go via `--arg`, never as inline jq literals.** An apostrophe in an inline literal closes the single-quoted jq program (yields a bash `syntax error near unexpected token`). `--rawfile` already covers the body; `--arg name "$VALUE"` (apostrophe-safe inside double quotes, referenced as `$name` in the filter) covers FM strings the same way. Hit 2026-06-15 on a session-log `agent.summary` containing "JS's".
  - Same downstream FM merge / closed-enum validation / auto-managed-key rejection / `created`-`updated` indexer-override as the markdown mode.
- **Write (markdown — round-trip only)**: `vault-curl /vault/{path} -X PUT -H 'Content-Type: text/markdown' --data-binary @file.md`
  - **Never hand-author YAML through this mode** — that's the recurring quoting-trap failure class (colon-space, leading `@`/`*`/`-`/`?`, hex/bool/date shadows), and per the 2026-06-11 decision it is reserved for the UI editor and for verbatim round-trips: GET a server-emitted file, text-edit the _body only_, PUT it back. The YAML you re-send was machine-serialized, so it's safe. Any FM change → use the JSON path above.
  - Add `-o /dev/null -w "%{http_code}\n"` to confirm a 204 without flooding stdout (works for either Content-Type).
- **Conditional writes (`If-Match`, use for read-modify-write on shared docs)**: `GET /vault/{path}` returns an `ETag` header (sha256 of the served bytes); send it back as `-H 'If-Match: <etag>'` on the PUT (either Content-Type) and the write lands only if the document hasn't changed in between — otherwise **412** `precondition_failed` with `details.current_etag`, meaning another writer got there first: re-GET, re-apply your edit to the fresh copy, retry with the new tag. Adopt this for any flow that GETs a shared doc (queue.md, learnings.md, archives), modifies it, and PUTs it back — it converts silent last-writer-wins clobbering into a visible, retryable conflict. Capture the ETag with `-D-` or `-o /dev/null -D- | grep -i etag`; successful PUTs (204) return the new `ETag` so chained conditional edits don't need a re-GET. `If-Match` never creates files (412 on a missing path); plain unconditional PUT remains valid for docs only one session touches.
- **Supersede (replace a note, archiving the old)**: `vault-curl /vault/supersede -X POST -H 'Content-Type: application/json' --data-binary @payload.json` with `{old_path, new_path?, frontmatter, body}` — the successor in the standard JSON write shape; `new_path` defaults to `old_path` (supersede-in-place: the successor takes over the path, so inbound wikilinks resolve to the replacement). Use this — never DELETE+PUT or a wholesale overwrite — whenever a write _replaces_ a note rather than evolving it: the old note moves to `<dir>/archive/<YYYY>/<name>` with its record id intact (edges/embeddings/suggestions survive) and gets `status: superseded`; the successor's body is auto-appended a `> Supersedes [[<archived-path>]].` footer that backs the typed `supersedes` edge (don't add your own). Validation-first — a rejected request (bad FM, occupied `new_path`/archive slot) mutates nothing. Routine edits to an existing note stay plain PUTs; supersession is for replacement semantics.
- **List**: `vault-curl /vault/{path}/ -s` (trailing slash → `{"files": [...]}`)
- **Delete**: `vault-curl /vault/{path} -X DELETE` — for junk with zero history value; a note retired _in favor of other content_ should be superseded (or moved to an archive folder), not deleted.
- **Search**: `vault-curl /search/simple/ -X POST -G --data-urlencode 'query=...'`
  - The vault REST API expects `query` as a URL parameter on a POST; `-G --data-urlencode` produces the right form.

### Pagination — page by `items.length`, never by your requested `limit`

Paginated reads (`/sections`, `/suggestions`) return an envelope
`{items, offset, limit, total}` that echoes the **effective** `offset`/`limit` —
the server caps `limit` (currently ≤ 100) and reports the value it actually
used, alongside `total`. So **advance by what you got, not what you asked
for**: step `offset += items.length` each page and stop when
`items.length === 0` (or `offset >= total`). Requesting `limit=200` returns
only 100; stepping `offset` by 200 then silently skips records 100–199 of every
page (the failure that under-counted a coverage scan 800/1513 and a suggestion
fetch 235/435). Never guess the page size — read the envelope, or just use the
returned array length. (Folder lists `/vault/{path}/` → `{files}` are **not**
paginated; they return everything in one shot.) Envelope-design rationale —
echo effective offset/limit, optional `total`, else a `last` flag or cursor:
`~/Open/articles/design/web-apps-client-server-api-design.md` § "Lists and
paging".

### Guard `jq` pipes in parallel Bash batches

When you fire several calls as parallel Bash tool calls in one message — as
`/vault resume`, `/vault wrap`, and `/vault sweep` all do — never let a
`vault-curl … | jq …` pipe exit non-zero. If the API returns an unexpected
shape, `jq` exits non-zero → the Bash call exits non-zero → the harness
**cancels its in-flight parallel siblings** (the classic casualty is
`check-drift.sh` sharing a batch with these reads). Append `|| true` to any
such pipe (or guard it as `if vault-curl …; then jq …; fi`) so a malformed
response degrades to empty output instead of taking down the whole batch.
Bare `vault-curl … -s` reads with no `jq` stage are already safe and need no
guard.

**`check-drift.sh` is also a _canceller_, not just a casualty.** It exits `1`
whenever it detects drift — the common case, not an error. Co-batched as a
parallel Bash sibling, that exit-1 cancels the _other_ calls (reindex, lint,
suggestions, agent-workflow reads). Run `check-drift.sh` in its **own** Bash
invocation, sequentially, before the parallel read batch — never inside it.
Read the drift report from stdout; the exit code is not the signal.

### Fallback: raw `curl`

If `vault-curl` is unavailable, verify env vars explicitly:

```bash
[[ -z "${VAULT_API_URL:-}" || -z "${VAULT_API_TOKEN:-}" ]] && { echo "Error: VAULT_API_URL and VAULT_API_TOKEN must be set in ~/.env"; exit 1; }
```

Then use `curl -H "Authorization: Bearer $VAULT_API_TOKEN" "$VAULT_API_URL/<path>"` with the same endpoints listed above.

## Vault structure

```
raw/               # unprocessed source material
topics/            # compiled wiki notes (1 concept = 1 note)
projects/          # per-project knowledge (subfolder per project)
  {project}/
    decisions.md   # architecture & design decisions
    learnings.md   # gotchas, patterns, what worked
    stack.md       # tech stack & dependencies
    queue.md       # outstanding work
    state.md       # baseline snapshot for vault-check-drift
queries/           # filed Q&A research outputs
logs/              # session logs
_index.md          # archived 2026-04-29 — kept for inbound wikilinks; do not update
```

Discovery is dynamic via the live API, not via a curated index file:

| Question                           | Tool                                           |
| ---------------------------------- | ---------------------------------------------- |
| What topics exist?                 | `vault_list_folder("topics/")`                 |
| What projects?                     | `vault_list_folder("projects/")`               |
| Recent logs / queries              | `vault_list_pieces(type=log, updated_since=…)` |
| Find a note about X                | `vault_search(X, mode=semantic)`               |
| What links to / from X?            | `vault_backlinks(X)` / `vault_neighborhood(X)` |
| Tag taxonomy                       | `vault_list_tags`, `vault_records_by_tag`      |
| Top items across the fleet         | `vault_queue_top(limit=N)`                     |
| One project's open queue           | `vault_queue_by_project(name)`                 |
| One project's archive              | `vault_queue_project_archive(name)`            |
| Everything at priority N (Backlog) | `vault_queue_by_priority(n)`                   |
| Fleet-wide Active / Watching       | `vault_queue_by_section(section)`              |

Queue endpoints are backed by `queue_items`, a derivative the watcher keeps in
sync with each project's `queue.md` and `queue-archive.md`. Markdown stays
source of truth — see [[topics/project-queue-convention]] for the shape and
[[projects/vault-storage/design/queue-items-table]] for schema + identity
model. Call `vault_queue_reindex` after a multi-machine pull to repopulate
slices the watcher didn't witness.

## Note format

Every note MUST have YAML frontmatter:

```yaml
---
title: Note Title
tags: [topic1, topic2]
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: active
type: permanent | fleeting | project | query | log
related: ['[[other-note]]']
---
```

Rules:

- Filenames in kebab-case: `auth-flow.md`
- Use wikilinks: `[[note-name]]` (not markdown links) for internal references
- 1 concept per topic note (atomicity)
- Minimum 2 wikilinks per note (dense linking)
- Every note starts with a 1-2 sentence summary paragraph

## Commands

### /vault ingest

Compile **ready** raw notes into the wiki. Drafts (no `ready: true`)
are skipped — the user is still iterating on them.

1. **Pull the ready list.** `vault-curl /maintenance/raw-inbox -s | jq`
   returns `{ready: [...], drafts: [...]}`. Process only `ready`. If
   that array is empty, report "no ready notes; N drafts waiting" and
   stop. (The user flips `ready: true` in FM when a note is ripe.)
2. For each ready note, read the content via
   `vault-curl /vault/{path} -s`.
3. Extract concepts — create or update topic notes in `topics/`,
   project notes in `projects/<name>/`, or queue items in
   `projects/<name>/queue.md` per the content's nature. When a
   compilation _replaces_ an existing topic outright (the old note is
   being retired, not extended), use `POST /vault/supersede` instead of
   overwriting in place — the predecessor is archived with its record id
   and a typed `supersedes` edge instead of silently vanishing into a
   PUT.
4. Add wikilinks, backlinks, and tags on the derived notes.
5. **Enrich at capture.** When creating a new topic note (or materially
   rewriting an existing one), write the `agent:` block in the same PUT
   — born-enriched is cheaper than a later backfill pass through
   `/vault-enrich-all`. Field shape and quality guidance:
   `~/.claude/skills/vault-enrich-all/SKILL.md` § "Per-note `agent:`
   block shape" + § "Generate enrichment fields". Set
   `derived_from_hash: "auto"` — the server stamps the hash of the body
   it writes plus `derived_at` (2026-07-09; on an older server compute
   `sha256(body)` locally). **Use
   the JSON write path** (`Content-Type: application/json` with
   `{frontmatter: {...}, body: "..."}`); `agent.summary` regularly
   contains colon-space prose that 500s through the markdown path's
   YAML parser, and JSON sidesteps that whole class of authoring trap
   (the hash value also doesn't need explicit quoting under JSON — the
   value is a string in the JSON object, and the server's
   `yaml.stringify` emits the right YAML for it). The indexer picks
   the block up on import and folds the summary into the chunk-prefix
   at embed time.
6. **Archive the source.** After successful ingestion of a single raw
   note, in this order:
   - PUT the source with `ready` removed and `processed: true` added
     (and a `> Ingested YYYY-MM-DD → [[derived/note]]` footer pointing
     at the primary derived target if there is one).
   - `POST /vault/move` from `raw/<name>.md` to
     `raw/archive/<YYYY-MM-DD>-<name>.md` so the inbox surfaces only
     pending material.
     Process notes one-at-a-time end-to-end: derived note created →
     source updated → moved to archive. A failure mid-ingest leaves
     earlier notes archived and the rest still pending — safe to retry
     `/vault ingest` to resume.

### /vault learn

Extract learnings from the current project/session.

1. Identify the current project from git remote, directory name, or ask
2. Read existing project notes if they exist (`projects/{name}/`) — in one
   call via `vault-curl "/system/resume-bundle?project=<name>&logs=0&project_bodies=learnings,decisions,stack,queue" -X POST -s`
   (full bodies for the dedup pass; feedback.md always included; on an older
   server fall back to individual reads)
3. Analyze recent work: git log, changed files, decisions made
4. Create or update `projects/{name}/learnings.md`, `decisions.md`, `stack.md`
5. Extract cross-project patterns into `topics/` notes (e.g., "api-rate-limiting", "docker-networking"). Propose-then-write: before creating, check neighbours with `POST /vault/propose` (search-before-write); if an existing note already covers the concept, extend it, and if the new write would _replace_ it wholesale, use `POST /vault/supersede` rather than minting a near-duplicate. When creating a new topic note here, enrich at capture per the `/vault ingest` step 5 procedure — write the `agent:` block in the same PUT.
6. **Promote this session's new durable local memories into the vault.** During the session the agent's auto-memory writes land in _per-machine_ local memory (`~/.claude/projects/<hash>/memory/`), which is not fleet-shared. For each `feedback_*.md` / `project_*.md` written or materially updated this session, route it by the `projects/agent-workflow/decisions` D1 table — feedback rules → `projects/<name>/feedback.md`, project facts / deferred options → `decisions.md` / `queue.md` Backlog — **deduped and propose-then-confirm**, never a blind copy. Most candidates are already captured elsewhere: verify against `decisions.md` / `learnings.md` / global `CLAUDE.md` / existing `topics/` first (per `topics/project-feedback-md-convention`). The vault is the durable source of truth; where a local memory is promoted, leave a thin local pointer rather than a duplicate fact (double-writing the same rule to both stores reintroduces drift). This makes the local→vault migration continuous so per-machine memories stop accumulating. This is the **write path** that pairs with `/vault resume`'s read of `feedback.md`.

### /vault query {question}

Research a question against the vault.

1. Use `vault_search` (or `POST /search/simple/`) to find candidate notes — try `mode=semantic` for conceptual queries, `mode=lexical` for verbatim phrases.
2. Read the most relevant notes (use `vault_neighborhood` or `vault_backlinks` to expand context if a single note isn't enough).
3. Synthesize an answer.
4. Optionally file the answer into `queries/YYYY-MM-DD-{slug}.md` if substantive — wikilinks back to the source notes used.

### /vault lint

The **hygiene** lint, implemented as its own skill — `/vault-lint`
(`~/.claude/skills/vault-lint/vault-lint.mjs`). It reads every indexed record
via `/sections` and reports five categories — `FRONTMATTER` (required keys, date
sanity), `WIKILINKS` (broken body targets), `DENSITY` (topic notes < 2 outbound;
isolated project notes), `CURRENCY` (per-type retention), `DUPLICATES`
(near-identical folders / titles) — against the thresholds in
`topics/vault-hygiene-policy.md`. Exit `0` clean, `1` on findings. Read-only:
it reports, never fixes. Full docs + flags + v1 limitations:
`~/.claude/skills/vault-lint/SKILL.md`.

```bash
~/.claude/skills/vault-lint/vault-lint.mjs           # full report
~/.claude/skills/vault-lint/vault-lint.mjs --quiet   # tab-separated data lines (pipe/grep)
```

Do not confuse it with the server-side **integrity** lint, which is a different
tool (embeddings / orphans / temporal anomalies / tag aliases — _not_ hygiene):

```bash
vault-curl /system/lint -s   # integrity, NOT hygiene
```

On findings, decide (the linter won't):

- Fix legitimate issues directly (frontmatter backfill, broken-link rewrites).
- For per-type retention findings (e.g., logs > 90 days), move to
  `logs/archive/<YYYY>/` rather than delete; archival preserves content while
  removing it from the default `/vault resume` reading set.
- For duplicate-folder candidates, decide canonical and bulk-rewrite inbound
  wikilinks (the 2026-04-27 `tape6/` → `tape-six/` dedup is the procedural
  template — see `projects/tape-six/decisions.md` § Project name).

### /vault log {description}

Save a session log.

1. Create `logs/YYYY-MM-DD-{description}.md`
2. Record: what was done, decisions made, pending items, key files touched
3. Add wikilinks to relevant topic/project notes
4. **Enrich at capture.** Write the `agent:` block in the **same** PUT that
   creates the log — born-enriched, so the log is searchable-sharp while it's
   hot (the `agent.summary` becomes a HyDE prefix at embed time), with no later
   backfill. Logs are append-only, so the block never re-stales. Use the JSON
   write path (`{frontmatter: {agent: {...}}, body: "..."}`); set
   `complexity: log-entry`; set `derived_from_hash: "auto"` — the server
   replaces the sentinel with the hash of the body it writes and stamps
   `derived_at` too (2026-07-09; on an older server compute `sha256(body)`
   locally).
   Field shape + quality guidance:
   `~/.claude/skills/vault-enrich-all/SKILL.md`. **Don't backfill _old_ logs** —
   enrichment value is largest at capture: a log is already self-describing
   (dated title + sections), so a retroactive summary adds little, and logs age
   out to `logs/archive/` at 90d. Born-enrich the new one; leave the old ones.
5. **Refresh the drift baseline.** Run
   `~/.claude/skills/vault-check-drift/check-drift.sh --update` from the project
   directory so the next `/vault resume` starts from a clean baseline (the
   session's commits / tags / `npm publish` are typically done by the time
   you're logging). Bootstraps `state.md` if the project has no baseline yet.
   Skip only when there's no project working directory in scope (rare —
   logging cross-project work, vault-only sessions).

### /vault resume

Rebuild context from the vault. Several steps below run as parallel Bash
calls; guard every `vault-curl … | jq …` pipe with `|| true` per § "Guard
`jq` pipes in parallel Bash batches" so a malformed response can't cancel
`check-drift.sh` running in the same batch.

1. **Drift check first.** Run `~/.claude/skills/vault-check-drift/check-drift.sh`
   from the current project directory (see the `vault-check-drift` skill for
   details) as its **own** Bash call — _not_ inside the parallel batch in
   steps 2–5. It exits `1` whenever it detects drift (the common case), which
   would cancel co-batched siblings; read the report from stdout. If drift is
   detected, surface it at the top of the resume output before reading logs —
   the vault's view of the project may be stale, and the recorded logs reflect
   that stale view.
2. **One-shot bundle** — call
   `vault-curl "/system/resume-bundle?project=<name>&logs=3" -X POST -s`
   with `<name>` = the current project (from git remote or directory
   name). The server runs the incremental reindex first, then packages
   what used to be five separate reads. Surface each block per the old
   rules:
   - `reindex` — quiet on a no-op (`changedFiles: 0`); report counts when
     something got reindexed; mention `fellBack: true` (the full-reindex
     path — history loss or first run).
   - `lint` — pre-filtered to non-zero checks. If `ok=false`, surface the
     categories with counts and first samples at the top of the resume
     output. These are bug indicators — report, don't auto-fix.
   - `suggestions` — `{total, by_kind}` of pendings. If `total > 0`, one
     summary line; the dedicated review skills handle decisions.
   - `workflow` — `active` is the agent-workflow Active section: surface
     verbatim under a `Workflow:` heading when non-null. If
     `clarify_pending > 0`, one line like
     `Clarify queue: N pending (/clarify to drain)`. Nulls mean the
     surface isn't scaffolded — omit silently.
   - `logs` — the most recent session logs as their `agent.summary`
     lines. Skim the summaries; fetch a full body
     (`vault-curl /vault/{path} -s`) only when a summary is missing or
     the session directly continues that log's work.
   - `project` — `feedback.md` arrives with its full body: surface its
     rules near the top of the resume output (this is the read path for
     fleet-shared project feedback — the vault is pull-only, not
     auto-loaded like local memory; see
     `topics/project-feedback-md-convention`). The other files
     (queue/decisions/learnings/stack) come as `summary` + `body_bytes`;
     fetch bodies only as needed.
3. **Fallback (pre-bundle server).** A 404 from the bundle endpoint means
   an older server — run the individual calls instead: `POST
/maintenance/incremental-reindex`, `GET /system/lint`,
   `GET /suggestions/summary`, the two agent-workflow file reads
   (`projects/agent-workflow/queue.md` § Active,
   `clarify-queue.md` pending count), the 3 most recent `logs/` entries,
   and the project's notes including `feedback.md` — guarding every
   `vault-curl … | jq …` pipe with `|| true` per § "Guard `jq` pipes in
   parallel Bash batches".
4. Summarize current state and what's left to do. If `check-drift` flagged
   new commits / tags / publishes that aren't reflected in `projects/<name>`
   notes, update those notes to match (or at minimum flag the divergence in
   the summary).
5. After syncing, run `check-drift --update` so the baseline captures the
   refreshed view and the next resume starts from a clean slate.

### /vault wrap [optional log slug]

Close the session cleanly — symmetric counterpart to `/vault resume`. Bundles
learning extraction, session log, and drift baseline refresh into one step so
nothing the session produced gets lost.

1. Run the `/vault learn` workflow above — extract learnings into
   `projects/{name}/{learnings,decisions,stack}.md` and surface cross-project
   patterns into `topics/` notes.
2. Run the `/vault log` workflow above with the supplied slug (or derive one
   from the session's primary subject if the user didn't supply it). Step 4 of
   `/vault log` refreshes the drift baseline as its closing action — no
   separate `check-drift --update` invocation needed here.
3. Report a short summary of what was saved: project notes touched, log file
   path, baseline refreshed.

Use this when ending a session that produced shipped work, decisions, or
cross-project learnings worth preserving. Skip when a session ends with
nothing worth preserving — don't write stub logs to be ceremonial.

### /vault check [--update]

Run the drift check standalone. Typically used mid-session to re-sync
after a user-driven commit, push, or publish.

```bash
~/.claude/skills/vault-check-drift/check-drift.sh            # report only
~/.claude/skills/vault-check-drift/check-drift.sh --update   # report + refresh baseline
```

The skill file at `~/.claude/skills/vault-check-drift/SKILL.md` documents
the signal sources, baseline file format, and report shape.

In multi-writer setups (the host pulls vault-data from a remote that
another machine pushed to), follow the project drift check with an
incremental reindex so the local DB catches up to the new HEAD:

```bash
vault-curl /maintenance/incremental-reindex -X POST -s | jq
```

Skip when working solo or when no `git pull` has happened recently —
the watcher already kept the DB in sync with local edits. A no-op call
is fast (a few ms) but unnecessary. The endpoint reports
`{fromCommit, toCommit, changedFiles, imported, deleted, renamed,
fellBack, durationMs}`; surface anything non-zero, otherwise stay
quiet.

### /vault sweep [options]

Drain every safely-automatable maintenance queue in one pass. Orchestrates
the existing review/cleanup skills + endpoints; loops each queue with
`--auto --limit=100` until the count hits zero or stops dropping.

```
/vault sweep                         # safe defaults
/vault sweep --dry-run               # report what would run; no writes
/vault sweep --include=edge_type,new_tag
/vault sweep --exclude=tag_suggestion
/vault sweep --include-destructive   # also runs duplicate review + compaction
/vault sweep --max-passes=N          # loop cap per kind (default 5)
```

#### Safe set (default)

Listed in execution order (see § Ordering constraints):

| Source                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Action                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `lint.orphan_embeddings` + `lint.orphan_doc_embeddings`                                                                                                                                                                                                                                                                                                                                                                                                           | `POST /maintenance/cleanup-lint`                                 |
| `lint.records_without_embeddings` + `lint.embedding_hash_drift`                                                                                                                                                                                                                                                                                                                                                                                                   | `POST /maintenance/embed-pending`                                |
| **coverage**: enrichable knowledge notes with **no `agent:` block** — canonical source is `vault-storage`'s `GET /system/lint` → `coverage.enrichment` (`ENRICHABLE_TYPES` = `permanent`/`project`/`design`/`research`/`query`; the headline already excludes operational types, empty bodies, and archived). Read the count there; `/vault-enrich-all` § Enrichable set drives the enumeration. _Not_ a suggestion kind, so invisible to `/suggestions/summary`. | `/vault-enrich-all --auto --limit=100` (backfill missing)        |
| `suggestions.agent_enrichment_stale`                                                                                                                                                                                                                                                                                                                                                                                                                              | `/vault-enrich-all --auto --stale --limit=100` (refresh drifted) |
| `suggestions.new_tag`                                                                                                                                                                                                                                                                                                                                                                                                                                             | `/vault-review-tags --auto --limit=100`                          |
| `suggestions.tag_suggestion`                                                                                                                                                                                                                                                                                                                                                                                                                                      | `/vault-review-tags --auto --kind=tag_suggestion --limit=100`    |
| `suggestions.edge_type`                                                                                                                                                                                                                                                                                                                                                                                                                                           | `/vault-review-edges --auto --limit=100`                         |

#### Opt-in (`--include-destructive`)

| Source                             | Action                                                           |
| ---------------------------------- | ---------------------------------------------------------------- |
| `suggestions.duplicate`            | `/vault-review-duplicates --auto --limit=100` (merge can delete) |
| `suggestions.compaction_candidate` | `/vault-compact <folder>` per candidate                          |

#### Always skipped

- `raw_inbox.ready` — `/vault ingest` is a separate workflow; the user
  flips `ready: true` when a draft is finished, not the sweep.
- `suggestions.archive_candidate` — per-record retention judgment.
- `suggestions.inefficiency_detected` / `infrastructure_upgrade` —
  reports-only, no action surface.

#### Ordering constraints

Some kinds mutate state that other kinds read. Process them in declared
order; never dispatch two ordered kinds as parallel sub-agents.

- **Enrichment before the tag and edge passes.** Both enrichment passes
  (the missing-block backfill `/vault-enrich-all --auto --limit=100` and the
  `--stale` refresh) write `agent:` blocks, and a freshly written block makes
  the server file new `tag_suggestion` (from `agent.tags_suggested`),
  sometimes `new_tag` (an unknown suggested tag), and can feed `edge_type`
  (from `agent.edge_classifications`). Run **both enrichment passes first**,
  then `new_tag` → `tag_suggestion` → `edge_type`, so the suggestions
  enrichment generates drain in the _same_ sweep instead of surfacing as
  residue. (Before this ordering enrichment ran last, and the `tag_suggestion`
  items it filed were always left for the next sweep — observed 2026-06-21.)
- **`new_tag` before `tag_suggestion`.** `new_tag` mints canonical tags
  and aliases into the taxonomy; `tag_suggestion`'s accept/reject logic
  reads the canonical-taxonomy state at decision time. Parallel
  dispatch races — a `tag_suggestion` agent can reject a suggestion
  whose tag the concurrent `new_tag` agent is about to canonicalize.
  Drain `new_tag` to zero (or to a stuck pass) before starting
  `tag_suggestion`. The 2026-05-13 instance was harmless (the tag was
  already on the record's FM, so the rejection didn't drop intent),
  but the failure mode generalizes.

Kinds with no declared ordering have no inter-kind dependency; they
may run sequentially in arbitrary order. Default to sequential
per-kind processing — concurrent sub-agents complicate failure
attribution and the per-kind passes are already cheap.

#### Procedure

1. **Baseline.** Pull `vault-curl /system/lint -s`,
   `vault-curl /suggestions/summary -s`, the **enrichment-coverage count**
   (enrichable knowledge notes lacking an `agent:` block — from the
   `/vault-enrich-all` coverage scan; this is _not_ a suggestion kind, so
   `/suggestions/summary` never shows it), and (cheap) record counts.
   Compute the action set from the safe defaults plus
   `--include` / `--exclude` / `--include-destructive`.
2. **Dry-run.** If `--dry-run`, print the planned action set with
   per-kind counts and stop.
3. **One-shot endpoints first.** Run `cleanup-lint` and `embed-pending`
   (in parallel, both POST). Each completes in seconds; together they
   tighten the lint baseline before the suggestion-driven passes
   touch records.
4. **Per-kind drain loop.** Process the actions **sequentially**, one fully
   drained before the next starts, in the order set by § Ordering constraints:
   the two **enrichment passes first** (missing-block backfill, then
   `--stale`), then `new_tag` → `tag_suggestion` → `edge_type`. Never dispatch
   two kinds as concurrent sub-agents — even pairs with no declared ordering,
   since concurrent FM writes muddy failure attribution. For each action, for
   at most `--max-passes` iterations (default 5):
   - Dispatch the corresponding skill with `--auto --limit=100`.
   - Re-measure that action's backlog: `/suggestions/summary` for the
     suggestion kinds; the coverage scan (notes lacking an `agent:` block)
     for the missing-block backfill.
   - Stop when the count reaches 0, or when it didn't decrease since the
     previous pass (stuck — sub-agent deferred, or items need human
     judgment).
5. **Final summary.** Print before/after counts per kind, total time,
   and any kind that stopped above zero with a note about why
   (max-passes reached vs. stuck vs. skipped).

A stuck kind isn't a failure — some suggestions legitimately need user
input, and the sub-agent's `--auto` mode is conservative on ambiguity.
The summary surfaces the residue so the user can decide whether to
hand-triage or leave it for the next sweep.

The action set is computed once from the baseline at step 1. With enrichment
now running first, its downstream tag/edge suggestions drain in the same
sweep; any suggestion that still emerges **after its own pass has already
run** is reported as residue, not chased. This keeps each invocation bounded;
a second `/vault sweep` picks them up.

### /vault (no subcommand)

Show vault status: note counts per folder, recently updated notes, any lint warnings.

## Proactive behavior

This skill should be used proactively when:

- The user discovers a non-obvious pattern, gotcha, or decision worth preserving
- A debugging session reveals something that would save time in the future
- Cross-project knowledge is generated (e.g., "this Docker networking trick works everywhere")
- The user says "remember this", "save this", "note this down"

When in doubt, ask: "Want me to save this to the vault?"
