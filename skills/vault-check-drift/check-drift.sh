#!/usr/bin/env bash
#
# vault-check-drift — compare a project's current state (git + npm) against
# the recorded baseline in the vault's `projects/<name>/state.md` and flag:
#
#   DRIFT      — commits / tags / publishes that appeared since last baseline
#   SYNC       — local branch ahead/behind upstream (unpushed / unpulled)
#   TREE       — uncommitted edits, staged changes, untracked files, stashes
#   RECONCILE  — git tags vs. npm published versions (mismatch means you
#                forgot to tag, forgot to publish, or published off-branch)
#
# Usage:
#   check-drift.sh [project-name]       # report-only; exit 1 on drift
#   check-drift.sh [project-name] --update   # report AND refresh the baseline
#
# Project name defaults to the basename of the nearest git repo root. State
# is read/written via the Obsidian Local REST API through `vault-curl`.

set -euo pipefail

UPDATE=false
PROJECT=""
for arg in "$@"; do
  case "$arg" in
    --update) UPDATE=true ;;
    --*) echo "Unknown flag: $arg" >&2; exit 2 ;;
    *) PROJECT="$arg" ;;
  esac
done

if ! REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo "Not inside a git repo. Run from a project directory." >&2
  exit 2
fi
cd "$REPO_ROOT"
PROJECT="${PROJECT:-$(basename "$REPO_ROOT")}"

command -v vault-curl >/dev/null || { echo "vault-curl missing" >&2; exit 2; }
command -v jq >/dev/null          || { echo "jq missing" >&2; exit 2; }

# ─── Collect live state ──────────────────────────────────────────────────────

ts_now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

repo_remote=$(git config --get remote.origin.url 2>/dev/null || echo "")
repo_head_sha=$(git rev-parse HEAD 2>/dev/null || echo "")
repo_head_subject=$(git log -1 --format="%s" 2>/dev/null || echo "")
repo_head_date=$(git log -1 --format="%cs" 2>/dev/null || echo "")
repo_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

# Tags, sorted by creation date (newest first). Empty string if none.
git_tags_json=$(git tag -l --sort=-creatordate | jq -Rsc 'split("\n") | map(select(length > 0))')

# Local vs upstream counts (ahead / behind), only if upstream is tracked.
ahead=0
behind=0
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  ahead=$(git rev-list --count '@{u}..HEAD')
  behind=$(git rev-list --count 'HEAD..@{u}')
fi

# Unpushed commit subjects.
unpushed_json="[]"
if [ "$ahead" -gt 0 ]; then
  unpushed_json=$(git log '@{u}..HEAD' --format='%h %s' | jq -Rsc 'split("\n") | map(select(length > 0))')
fi

# Working tree.
status_lines=$(git status --porcelain)
tree_modified=$(printf '%s\n' "$status_lines" | awk '$1 ~ /^M|^.M|^MM/ {print $2}' | jq -Rsc 'split("\n") | map(select(length > 0))')
tree_staged=$(printf '%s\n' "$status_lines"   | awk '$1 ~ /^A|^D|^R/ {print $2}'      | jq -Rsc 'split("\n") | map(select(length > 0))')
tree_untracked=$(printf '%s\n' "$status_lines" | awk '$1 == "??" {print $2}'            | jq -Rsc 'split("\n") | map(select(length > 0))')
stash_count=$(git stash list 2>/dev/null | wc -l | tr -d ' ')

# Submodules.
submodules_json="{}"
if [ -f .gitmodules ]; then
  submodules_json=$(git submodule status 2>/dev/null | awk '
    { sha=$1; sub(/^[-+]/, "", sha); print sha "\t" $2 }' |
    jq -Rsc 'split("\n")
      | map(select(length > 0) | split("\t") | {name: .[1], head: .[0]})
      | map({(.name): {head: .head}})
      | add // {}')
fi

# ─── Load recorded baseline from vault ───────────────────────────────────────

vault_path="/vault/projects/${PROJECT}/state.md"
raw_state=$(vault-curl "$vault_path" -s 2>/dev/null || true)
# Extract the fenced ```json ... ``` block from the markdown body.
baseline_json=$(printf '%s' "$raw_state" | awk '
  /^```json$/ {cap=1; next}
  /^```$/ && cap {exit}
  cap {print}')
if [ -z "$baseline_json" ]; then
  baseline_json='null'
fi

# ─── Build current snapshot as JSON ──────────────────────────────────────────

# Probe npm if the baseline recorded a package name, or infer from package.json.
npm_name=""
if [ -f package.json ]; then
  npm_name=$(jq -r '.name // empty' package.json)
  npm_private=$(jq -r '.private // empty' package.json)
  [ "$npm_private" = "true" ] && npm_name=""
fi
npm_versions_json="[]"
npm_latest="null"
if [ -n "$npm_name" ]; then
  if reg_out=$(npm view "$npm_name" versions --json 2>/dev/null); then
    npm_versions_json=$(printf '%s' "$reg_out" | jq -c 'if type == "array" then . else [.] end')
    npm_latest=$(printf '%s' "$npm_versions_json" | jq -c '.[-1] // null')
  fi
fi

current_json=$(jq -n \
  --arg proj "$PROJECT" \
  --arg ts "$ts_now" \
  --arg remote "$repo_remote" \
  --arg head "$repo_head_sha" \
  --arg subj "$repo_head_subject" \
  --arg hdate "$repo_head_date" \
  --arg branch "$repo_branch" \
  --argjson tags "$git_tags_json" \
  --argjson subs "$submodules_json" \
  --arg npm_name "$npm_name" \
  --argjson npm_versions "$npm_versions_json" \
  --argjson npm_latest "$npm_latest" \
  '{
    project: $proj,
    last_checked: $ts,
    repo: {
      remote: $remote,
      branch: $branch,
      head: {sha: $head, subject: $subj, date: $hdate},
      tags: $tags
    },
    submodules: $subs,
    publishable: {
      npm: (if ($npm_name | length) > 0 then {name: $npm_name, latest: $npm_latest, versions: $npm_versions} else null end)
    }
  }')

# ─── Diff against baseline ───────────────────────────────────────────────────

drift_lines=()

if [ "$baseline_json" = "null" ]; then
  drift_lines+=("(no baseline recorded — run with --update to bootstrap)")
else
  old_head=$(jq -r '.repo.head.sha // empty' <<<"$baseline_json")
  new_head=$(jq -r '.repo.head.sha' <<<"$current_json")
  if [ -n "$old_head" ] && [ "$old_head" != "$new_head" ]; then
    new_commits=$(git log "${old_head}..HEAD" --oneline 2>/dev/null | head -10 || echo "")
    if [ -n "$new_commits" ]; then
      while IFS= read -r line; do
        drift_lines+=("commit: $line")
      done <<<"$new_commits"
    else
      drift_lines+=("HEAD moved ${old_head:0:7} → ${new_head:0:7} (no forward history — rebase / reset?)")
    fi
  fi

  # Tag delta (any tag in current not in baseline).
  new_tags=$(jq -r --argjson old "$(jq -c '.repo.tags // []' <<<"$baseline_json")" \
    '.repo.tags - $old | .[]?' <<<"$current_json")
  while IFS= read -r tag; do
    [ -n "$tag" ] && drift_lines+=("tag: +$tag")
  done <<<"$new_tags"

  # npm publish delta.
  old_versions=$(jq -c '.publishable.npm.versions // []' <<<"$baseline_json")
  new_versions=$(jq -r --argjson old "$old_versions" \
    '(.publishable.npm.versions // []) - $old | .[]?' <<<"$current_json")
  while IFS= read -r v; do
    [ -n "$v" ] && drift_lines+=("npm: +$v published")
  done <<<"$new_versions"

  # Submodule drift.
  while IFS= read -r sub; do
    [ -z "$sub" ] && continue
    old=$(jq -r --arg s "$sub" '.submodules[$s].head // empty' <<<"$baseline_json")
    new=$(jq -r --arg s "$sub" '.submodules[$s].head // empty' <<<"$current_json")
    if [ -n "$old" ] && [ -n "$new" ] && [ "$old" != "$new" ]; then
      drift_lines+=("submodule $sub: ${old:0:7} → ${new:0:7}")
    fi
  done < <(jq -r '.submodules | keys[]?' <<<"$current_json")
fi

# ─── Tag ↔ npm reconciliation ────────────────────────────────────────────────

reconcile_lines=()
if [ -n "$npm_name" ] && [ "$npm_versions_json" != "[]" ]; then
  # Only reconcile the recent window — historical mismatches from a project's
  # pre-tagging era aren't actionable and would flood the report.
  recent_tags=$(jq -c 'sort | reverse | .[0:10]' <<<"$git_tags_json")
  recent_versions=$(jq -c 'sort | reverse | .[0:10]' <<<"$npm_versions_json")

  unpublished=$(jq -r --argjson v "$recent_versions" '.[] | select([.] - $v | length > 0)' <<<"$recent_tags")
  while IFS= read -r t; do
    [ -n "$t" ] && reconcile_lines+=("tag $t: no matching npm publish")
  done <<<"$unpublished"

  untagged=$(jq -r --argjson t "$recent_tags" '.[] | select([.] - $t | length > 0)' <<<"$recent_versions")
  while IFS= read -r v; do
    [ -n "$v" ] && reconcile_lines+=("npm $v: no matching git tag")
  done <<<"$untagged"

  # Cap total reconcile output.
  if [ "${#reconcile_lines[@]}" -gt 6 ]; then
    extra=$(( ${#reconcile_lines[@]} - 6 ))
    reconcile_lines=("${reconcile_lines[@]:0:6}" "(+$extra more — inspect with git tag / npm view)")
  fi
fi

# ─── Emit report ─────────────────────────────────────────────────────────────

any_drift=false
print_section() {
  local title="$1"; shift
  local n=0
  for l in "$@"; do [ -n "$l" ] && n=$((n+1)); done
  [ "$n" -eq 0 ] && return
  printf '%s:\n' "$title"
  for l in "$@"; do
    [ -n "$l" ] && printf '  %s\n' "$l"
  done
  any_drift=true
}

print_section "DRIFT since last baseline" "${drift_lines[@]}"

sync_lines=()
if [ "$ahead" -gt 0 ] || [ "$behind" -gt 0 ]; then
  sync_lines+=("$repo_branch: $ahead ahead, $behind behind upstream")
  if [ "$ahead" -gt 0 ]; then
    while IFS= read -r c; do
      [ -n "$c" ] && sync_lines+=("  unpushed: $c")
    done < <(jq -r '.[]' <<<"$unpushed_json")
  fi
fi
# Submodule sync.
if [ -f .gitmodules ]; then
  while IFS= read -r sub; do
    [ -z "$sub" ] && continue
    if ( cd "$sub" && git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 ); then
      sa=$(cd "$sub" && git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
      sb=$(cd "$sub" && git rev-list --count 'HEAD..@{u}' 2>/dev/null || echo 0)
      if [ "$sa" -gt 0 ] || [ "$sb" -gt 0 ]; then
        sync_lines+=("$sub: $sa ahead, $sb behind upstream")
      fi
    fi
  done < <(git config --file .gitmodules --get-regexp '^submodule\..*\.path$' | awk '{print $2}')
fi
print_section "LOCAL vs REMOTE" "${sync_lines[@]}"

tree_lines=()
n_mod=$(jq 'length' <<<"$tree_modified")
n_stg=$(jq 'length' <<<"$tree_staged")
n_unt=$(jq 'length' <<<"$tree_untracked")
[ "$n_mod" -gt 0 ] && tree_lines+=("modified ($n_mod): $(jq -r 'join(", ")' <<<"$tree_modified" | cut -c1-200)")
[ "$n_stg" -gt 0 ] && tree_lines+=("staged ($n_stg): $(jq -r 'join(", ")' <<<"$tree_staged" | cut -c1-200)")
[ "$n_unt" -gt 0 ] && tree_lines+=("untracked ($n_unt): $(jq -r 'join(", ")' <<<"$tree_untracked" | cut -c1-200)")
[ "$stash_count" -gt 0 ] && tree_lines+=("stash entries: $stash_count")
print_section "WORKING TREE" "${tree_lines[@]}"

print_section "RECONCILE tags ↔ npm" "${reconcile_lines[@]}"

if ! $any_drift; then
  printf 'project "%s": state matches vault; tree clean; last checked %s\n' "$PROJECT" "$ts_now"
fi

# ─── Persist baseline if --update ────────────────────────────────────────────

if $UPDATE; then
  body=$(printf 'Auto-maintained by the `vault-check-drift` skill. Refresh: run `/vault check --update`\nfrom the project directory, or re-run `/vault resume`.\n\n## Baseline snapshot\n\n```json\n%s\n```\n' "$(jq . <<<"$current_json")")
  printf -- '---\ntitle: %s — state snapshot\ntype: state\ntags: [state, snapshot, %s]\nupdated: %s\n---\n\n%s' \
    "$PROJECT" "$PROJECT" "${ts_now%T*}" "$body" > /tmp/vault-state-${PROJECT}.md
  vault-curl "$vault_path" -X PUT -H 'Content-Type: text/markdown' \
    --data-binary "@/tmp/vault-state-${PROJECT}.md" -o /dev/null -w "state: %{http_code}\n"
  rm -f "/tmp/vault-state-${PROJECT}.md"
fi

$any_drift && exit 1 || exit 0
