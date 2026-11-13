#!/usr/bin/env bash
# Update the menubar plugin from the pinned GitHub fork release.
# Usage: update.sh [tag]  — with no argument, pins to the highest vetted
# swiftbar/v* release tag, falling back to main until the first tag is cut.
set -euo pipefail
REPO_SLUG="jeanibarz/knowledge-base-mcp-server"
REPO_RAW="https://raw.githubusercontent.com/${REPO_SLUG}"
TAGS_API="https://api.github.com/repos/${REPO_SLUG}/tags?per_page=100"
# Fallback file list. The list actually used comes from the target tag's own
# update.sh (see "fetch" below); this one is used only when that script has no
# parseable FILES line. Keep FILES="..." on a single line: newer updaters read
# it out of this file at older tags.
FILES="kb-mcp.10s.sh kb-mcp-rebuild.sh kb-mcp-reindex-status.sh kb-mcp-uninstall.sh install.sh uninstall.sh update.sh VERSION"

# Resolve the release tag to pull. An explicit argument wins; otherwise pick
# the highest swiftbar/v<semver> tag from the GitHub tags API, and fall back to
# main when none exists yet (bootstrap / offline). Server-wide vX.Y.Z tags are
# ignored — only the swiftbar/ namespace counts as a plugin release.
if [[ -n "${1:-}" ]]; then
  TAG="$1"
else
  # -L stays (repo-rename redirects are legitimate) but redirects may only
  # land on https — never on a cleartext host.
  LATEST="$(curl -fsSL --proto-redir '=https' -m 10 "$TAGS_API" 2>/dev/null \
    | grep -oE '"swiftbar/v[0-9]+\.[0-9]+\.[0-9]+"' \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' \
    | sort -V | tail -1 || true)"
  if [[ -n "$LATEST" ]]; then TAG="swiftbar/v$LATEST"; else TAG="main"; fi
fi

ENV_FILE="${KB_MENUBAR_ENV:-$HOME/.config/kb/menubar.env}"
# shellcheck source=/dev/null
[[ -f $ENV_FILE ]] && source "$ENV_FILE"
DST="${KB_MCP_REPO:-$HOME/workspace/knowledge-base-mcp-server}/plugins/swiftbar"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

echo "== fetch $TAG =="
# Take the file list from the target tag, not from this script. Releases add
# files (v1.1 added kb-mcp-reindex-status.sh), so a newer updater that asks an
# older tag for a file the tag never had would fail (issue #1242). Fetch the
# tag's update.sh first and read only its FILES="..." line; the fetched script
# is never sourced or run here. Each name becomes a write path under $DST, so
# it must be a plain file name (no "/", no leading ".") or the update aborts.
curl -fsSL --proto-redir '=https' -m 15 "$REPO_RAW/$TAG/plugins/swiftbar/update.sh" -o "$TMP/update.sh" \
  || { echo "update: fetch failed: update.sh"; exit 1; }
TAG_FILES="$(sed -n 's/^FILES="\([^"]*\)".*/\1/p' "$TMP/update.sh" | head -1)"
if [[ -n "${TAG_FILES// /}" ]]; then
  NAME_RE='^[A-Za-z0-9][A-Za-z0-9._-]*$'
  for f in $TAG_FILES; do
    [[ $f =~ $NAME_RE ]] || { echo "update: refusing unsafe file name from $TAG: $f"; exit 1; }
  done
  FILES="$TAG_FILES"
else
  echo "update: no FILES list in $TAG's update.sh; using this script's list"
fi
for f in $FILES; do
  [[ $f == update.sh ]] && continue  # fetched above
  curl -fsSL --proto-redir '=https' -m 15 "$REPO_RAW/$TAG/plugins/swiftbar/$f" -o "$TMP/$f" \
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
