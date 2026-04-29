---
name: vault-check-drift
description: Detect drift between a project's current state (git + npm) and the baseline recorded in the vault's `projects/<name>/state.md`. Flags: new commits / tags / publishes since the baseline, local branch ahead/behind upstream, working-tree mods / stash entries / untracked files, git-tag ↔ npm-version mismatches. Used automatically by `/vault resume` and standalone via `/vault check`.
user_invocable: true
---

# Vault — project state drift check

Answers four questions for the current project every time a new session starts:

1. **What happened externally since I was last here?** — commits, tags, npm publishes.
2. **Am I in sync with the remote?** — ahead / behind per branch and per submodule.
3. **Am I mid-task?** — working-tree mods, staged changes, untracked files, stashes.
4. **Did something ship out of step?** — git tags that aren't on npm, or vice versa.

All signals are cheap: local `git` ops plus one `npm view` call when a publishable package is detected. Network hits only happen when a `publishable.npm.name` is present in the baseline or in `package.json`.

## Invocation

### Automatic — inside `/vault resume`

`/vault resume` calls this skill as its first step. When drift is detected, resume's output leads with the drift report; when clean, resume emits a one-liner and proceeds to the log summary.

### Manual — `/vault check [--update]`

From a project directory:

```bash
~/.claude/skills/vault-check-drift/check-drift.sh            # report only
~/.claude/skills/vault-check-drift/check-drift.sh --update   # report + refresh baseline
```

Exit code `0` means clean; `1` means drift detected. The `--update` flag re-writes `projects/<name>/state.md` with the current values after reporting.

## Baseline storage

One file per project at `projects/<name>/state.md` in the vault. Frontmatter + a single fenced `json` block the script reads & writes:

```yaml
---
title: <name> — state snapshot
type: state
tags: [state, snapshot, <name>]
updated: YYYY-MM-DD
---

Auto-maintained by the `vault-check-drift` skill...

## Baseline snapshot

```json
{
  "project": "dynamodb-toolkit-koa",
  "last_checked": "2026-04-19T21:54:50Z",
  "repo": {
    "remote": "...",
    "branch": "master",
    "head": {"sha": "…", "subject": "…", "date": "YYYY-MM-DD"},
    "tags": []
  },
  "submodules": {"wiki": {"head": "…"}},
  "publishable": {"npm": {"name": "…", "latest": null, "versions": []}}
}
```
```

Only `repo.head.sha`, `repo.tags`, `submodules.*.head`, and `publishable.npm.versions` are used for diffing. The rest is context for human readers.

## Report sections

```
DRIFT since last baseline:
  commit: abc123 <subject>            ← new commits on current branch
  tag: +3.1.1                         ← new tags
  npm: +3.1.1 published               ← new publishes
  submodule wiki: 6a1411c → 7cde892   ← submodule HEAD moved

LOCAL vs REMOTE:
  master: 3 ahead, 0 behind upstream  ← unpushed commits
    unpushed: abc123 <subject>
    unpushed: def456 <subject>
  wiki: 1 ahead, 0 behind upstream

WORKING TREE:
  modified (2): src/index.js, package.json
  staged (1): tests/test-new.js
  untracked (1): notes/scratch.md
  stash entries: 1

RECONCILE tags ↔ npm:
  tag 3.1.0: no matching npm publish  ← forgot to publish
  npm 3.1.1: no matching git tag      ← forgot to tag
```

Empty sections are omitted. When nothing's wrong: one line — `project "X": state matches vault; tree clean; last checked <ts>`.

## Bootstrap

First run in a project with no baseline emits:

```
DRIFT since last baseline:
  (no baseline recorded — run with --update to bootstrap)
```

Run once with `--update` to seed `state.md`. Subsequent checks compare against that snapshot.

## When to update the baseline

- **After a commit / push / publish that this session performed.** Run `--update` at session end so the next resume sees the new baseline, not the old one.
- **After a user-driven change outside Claude.** When the user says "I committed / pushed / published", `--update` records their action as the new baseline.
- **Never silently.** The script prints what it recorded — no surprise rewrites.

Safe to re-run repeatedly: `state.md` is idempotent. Rate-limit: a separate `last_checked` timestamp inside the file lets callers skip redundant network calls if <15min elapsed (enforcement belongs in the caller, not the script).

## Dependencies

- `git` — local repo operations.
- `jq` — JSON parsing.
- `npm` — registry query when a publishable package is detected.
- `vault-curl` — Obsidian Local REST API access (reads + writes `state.md`).

Script exits 2 on missing deps or when invoked outside a git repo.
