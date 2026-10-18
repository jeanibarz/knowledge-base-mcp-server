#!/usr/bin/env bash
# prepare-upstream-branch.sh <branch-name>
#
# Creates a PR-ready branch for upstream (jeanibarz/knowledge-base-mcp-server)
# from origin/main, stripped of every path listed in FORK-ONLY.
#
# Usage:
#   scripts/prepare-upstream-branch.sh devin/my-change
#   git push -u origin devin/my-change
#   gh pr create --repo jeanibarz/knowledge-base-mcp-server \
#     --head gundestrup:devin/my-change --title "..." --body "..."
set -euo pipefail

branch="${1:?usage: $0 <branch-name>}"
root="$(git rev-parse --show-toplevel)"
manifest="$root/FORK-ONLY"

if [ ! -f "$manifest" ]; then
  echo "error: FORK-ONLY manifest not found at $manifest" >&2
  exit 1
fi

git fetch origin main --quiet
git checkout -b "$branch" origin/main

removed=()
while IFS= read -r line; do
  entry="${line%%#*}"                      # drop comments
  entry="$(printf '%s' "$entry" | xargs)"  # trim whitespace
  [ -z "$entry" ] && continue
  if [ -n "$(git ls-files -- "$entry")" ]; then
    git rm -r -q -- "$entry"
    removed+=("$entry")
  fi
done < "$manifest"

if [ "${#removed[@]}" -gt 0 ]; then
  git commit -q -m "chore: strip fork-local files for upstream PR

Removed per FORK-ONLY: ${removed[*]}"
  printf 'stripped: %s\n' "${removed[@]}"
else
  echo "nothing to strip — branch is identical to main"
fi

cat <<EOF

Next steps:
  git push -u origin $branch
  gh pr create --repo jeanibarz/knowledge-base-mcp-server \
    --head gundestrup:$branch --title "<title>" --body "<body>"
EOF
