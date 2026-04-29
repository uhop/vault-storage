#!/usr/bin/env bash
# Update a deployed vault-storage instance.
#
# What it does:
#   1. Aborts if the working tree is dirty (don't lose local edits).
#   2. Fetches + previews incoming commits.
#   3. Fast-forward pulls (no merge gymnastics — assumes deploy box is read-only).
#   4. Warns if .env is missing keys that .env.example added.
#   5. Builds the image with both `:latest` and `:<short-sha>` tags so you can
#      roll back by re-tagging.
#   6. Recreates the container via compose (image change triggers replace).
#
# Rollback: `docker tag vault-storage:<prev-sha> vault-storage:latest && docker compose up -d`

set -euo pipefail

cd "$(dirname "$0")/.."

# 1. Refuse to deploy on top of uncommitted local changes.
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
  echo "vault-storage update: working tree is dirty — commit or stash first." >&2
  git status --short >&2
  exit 1
fi

# 2. Show what's coming.
prev_sha=$(git rev-parse --short HEAD)
git fetch --quiet
upstream=$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
if [[ -z "$upstream" ]]; then
  echo "vault-storage update: no upstream tracking branch — set one with 'git branch --set-upstream-to=origin/<branch>'." >&2
  exit 1
fi
next_sha=$(git rev-parse --short "$upstream")

if [[ "$prev_sha" == "$next_sha" ]]; then
  echo "vault-storage update: already at $prev_sha. Re-running container."
  docker compose up -d
  exit 0
fi

echo "vault-storage update: $prev_sha → $next_sha"
echo
echo "Incoming commits:"
git --no-pager log --oneline "HEAD..$upstream"
echo

# 3. Pull.
git pull --ff-only --quiet

# 4. .env drift check.
if [[ -f .env && -f .env.example ]]; then
  example_keys=$(grep -oE '^[A-Z_][A-Z0-9_]*=' .env.example | tr -d '=' | sort -u)
  env_keys=$(grep -oE '^[A-Z_][A-Z0-9_]*=' .env | tr -d '=' | sort -u)
  missing=$(comm -23 <(echo "$example_keys") <(echo "$env_keys") || true)
  if [[ -n "$missing" ]]; then
    echo "Note: .env.example has keys not in your .env (defaults will apply):"
    echo "$missing" | sed 's/^/  /'
    echo "Add them to .env if you want non-default values."
    echo
  fi
fi

# 5. Build with SHA + latest tags.
sha=$(git rev-parse --short HEAD)
echo "vault-storage update: building :$sha + :latest"
docker build -t "vault-storage:$sha" -t vault-storage:latest .

# 6. Recreate container. Image SHA changed → compose replaces in place.
echo "vault-storage update: recreating container"
docker compose up -d

cat <<EOF

vault-storage update: complete. Active SHA: $sha
  rollback:
    docker tag vault-storage:$prev_sha vault-storage:latest && docker compose up -d
EOF
