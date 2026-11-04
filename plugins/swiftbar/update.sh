#!/usr/bin/env bash
# Update the menubar plugin from the pinned GitHub fork release.
# Usage: update.sh [tag]  — default tag: main
set -euo pipefail
REPO_RAW="https://raw.githubusercontent.com/jeanibarz/knowledge-base-mcp-server"
TAG="${1:-main}"
FILES="kb-mcp.10s.sh kb-mcp-rebuild.sh kb-mcp-uninstall.sh install.sh uninstall.sh update.sh VERSION"

ENV_FILE="${KB_MENUBAR_ENV:-$HOME/.config/kb/menubar.env}"
# shellcheck source=/dev/null
[[ -f $ENV_FILE ]] && source "$ENV_FILE"
DST="${KB_MCP_REPO:-$HOME/workspace/knowledge-base-mcp-server}/plugins/swiftbar"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "== fetch $TAG =="
for f in $FILES; do
  curl -fsSL -m 15 "$REPO_RAW/$TAG/plugins/swiftbar/$f" -o "$TMP/$f" \
    || { echo "update: fetch failed: $f"; exit 1; }
done
echo "== sanity-check =="
for f in "$TMP"/*.sh; do bash -n "$f" || { echo "update: bad syntax in $(basename "$f")"; exit 1; }; done
echo "== install to $DST =="
mkdir -p "$DST"
for f in $FILES; do cp "$TMP/$f" "$DST/$f"; done
chmod +x "$DST"/*.sh
echo "== re-run installer (relinks plugin + refreshes menubar.env) =="
"$DST/install.sh"
echo "updated to $(cat "$DST/VERSION")"
