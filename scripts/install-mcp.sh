#!/usr/bin/env sh
#
# vault-storage-mcp installer
#
# Downloads the latest (or pinned) MCP tarball from this repo's GitHub
# Releases, extracts it, installs production deps, and drops a launcher
# on your $PATH. No GitHub authentication required — the repo is public
# and so are the release assets.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/uhop/vault-storage/main/scripts/install-mcp.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/uhop/vault-storage/main/scripts/install-mcp.sh | sh -s -- --version 0.0.1
#   curl -fsSL https://raw.githubusercontent.com/uhop/vault-storage/main/scripts/install-mcp.sh | sh -s -- --prefix /opt/vault-mcp
#
# Flags:
#   --prefix DIR     Install root. Default: $HOME/.local
#                    Library lands in $PREFIX/lib/vault-storage-mcp/
#                    Launcher lands in $PREFIX/bin/vault-storage-mcp
#   --version VER    Specific MCP version. Default: latest. Accepts
#                    "0.0.1" or "mcp-0.0.1" — both work.
#   --help           Print this help.
#
# Requirements: node >= 25, npm, curl, tar.

set -eu

REPO="uhop/vault-storage"
PREFIX="${PREFIX:-$HOME/.local}"
VERSION="${VERSION:-latest}"

print_help() {
  sed -n '/^# vault-storage-mcp installer/,/^# Requirements:/p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)  PREFIX="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --help|-h) print_help; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# ─── Pre-flight ──────────────────────────────────────────────────────────────

for cmd in node npm curl tar; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "install-mcp: missing '$cmd' — please install it first" >&2
    exit 1
  fi
done

node_major=$(node -v | sed 's/^v\([0-9][0-9]*\).*/\1/')
if [ "$node_major" -lt 25 ]; then
  echo "install-mcp: node >= 25 required (have v$node_major)" >&2
  exit 1
fi

# ─── Resolve tag ─────────────────────────────────────────────────────────────

# Accept either "0.0.1" or "mcp-0.0.1" — normalize to the tag form the
# release uses (mcp-X.Y.Z).
case "$VERSION" in
  latest) ;;
  mcp-*)  TAG="$VERSION" ;;
  *)      TAG="mcp-$VERSION" ;;
esac

if [ "$VERSION" = "latest" ]; then
  echo "Resolving latest MCP release…"
  api="https://api.github.com/repos/$REPO/releases/latest"
  TAG=$(curl -fsSL "$api" | grep '"tag_name":' | head -1 | cut -d'"' -f4)
  if [ -z "${TAG:-}" ]; then
    echo "install-mcp: could not resolve latest release from $api" >&2
    exit 1
  fi
  case "$TAG" in
    mcp-*) ;;
    *)
      echo "install-mcp: latest release ($TAG) is not an MCP release." >&2
      echo "Pin one explicitly: --version 0.0.1" >&2
      exit 1
      ;;
  esac
fi

VER="${TAG#mcp-}"
ASSET="vault-storage-mcp-${VER}.tgz"
URL="https://github.com/$REPO/releases/download/$TAG/$ASSET"

# ─── Download + install ──────────────────────────────────────────────────────

LIBDIR="$PREFIX/lib/vault-storage-mcp"
BINDIR="$PREFIX/bin"
LAUNCHER="$BINDIR/vault-storage-mcp"

echo "Installing vault-storage-mcp $VER"
echo "  Source: $URL"
echo "  Lib:    $LIBDIR"
echo "  Bin:    $LAUNCHER"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

if ! curl -fsSL "$URL" -o "$tmpdir/$ASSET"; then
  echo "install-mcp: download failed from $URL" >&2
  exit 1
fi

# npm pack always produces tarballs with a top-level "package/" directory;
# strip it so files land directly under $LIBDIR.
mkdir -p "$LIBDIR"
tar -xzf "$tmpdir/$ASSET" -C "$LIBDIR" --strip-components=1

(cd "$LIBDIR" && npm install --omit=dev --silent --no-audit --no-fund)

mkdir -p "$BINDIR"
cat >"$LAUNCHER" <<EOF
#!/usr/bin/env sh
exec node "$LIBDIR/src/index.ts" "\$@"
EOF
chmod +x "$LAUNCHER"

# ─── Done ────────────────────────────────────────────────────────────────────

cat <<EOF

Installed.

Next: register with Claude Code (user scope, visible in every project):

  claude mcp add --scope user vault \\
    --env VAULT_API_URL=http://your-host:8123 \\
    --env VAULT_API_TOKEN=<bearer-token> \\
    -- $LAUNCHER

Or use a project-scope .mcp.json — see skills/README.md in this repo.

If $BINDIR is on your PATH, the launcher resolves as just 'vault-storage-mcp'.
EOF
