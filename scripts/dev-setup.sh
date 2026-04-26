#!/usr/bin/env bash
# One-shot local-development setup:
#   1. Install dependencies and build once.
#   2. Symlink this checkout's `kb` and `knowledge-base-mcp-server` bins into
#      the global node prefix via `npm link`. Subsequent rebuilds (manual or
#      via the post-merge hook) overwrite build/ in place — the global bins
#      pick up the new code without re-linking.
#   3. Point git at the tracked .githooks/ directory so the post-merge /
#      post-rewrite hooks fire after every `git pull` / `git merge` /
#      `git pull --rebase`.
#
# Step 3 runs LAST so that a failure in install/build/link leaves the repo
# in its original state instead of pointing at a hook that would run against
# a half-built tree.
#
# Idempotent: safe to re-run.

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

# Guard against npm_config_prefix leaking in from an outer pnpm/npm script
# context (e.g. running this from inside another package's `npm run`). When
# set, npm link installs into the wrong global prefix and the bin symlinks
# never get created in your real Node prefix.
if [[ -n "${npm_config_prefix:-}" ]]; then
  cat >&2 <<EOF
ERROR: npm_config_prefix is set to '${npm_config_prefix}' in this shell.
       This usually means you are running inside a pnpm / npm script context
       from another project. npm link would target the wrong prefix.
       Open a fresh shell and re-run, or unset the variable:
           unset npm_config_prefix npm_config_dir
EOF
  exit 1
fi

echo "==> Installing npm dependencies"
npm install

echo "==> Building"
npm run build

resolved_prefix="$(npm prefix -g)"
echo "==> Linking bins into npm global prefix: ${resolved_prefix}"
echo "    (override with PREFIX, NPM_CONFIG_PREFIX, or ~/.npmrc 'prefix=' if wrong)"
npm link

echo "==> Configuring git hooks path -> .githooks (post-merge + post-rewrite)"
chmod +x .githooks/post-merge scripts/*.sh 2>/dev/null || true
git config core.hooksPath .githooks

cat <<EOF

Done. The global \`kb\` and \`knowledge-base-mcp-server\` bins now point at
this checkout (${resolved_prefix}/bin/). From now on:

  - \`git pull\` (merge or rebase) auto-rebuilds via the post-merge /
    post-rewrite hooks.
  - Edit src/, run \`npm run build\`, and the global bins reflect it
    immediately — no re-link needed.
  - To unlink: \`npm unlink -g @jeanibarz/knowledge-base-mcp-server\`
  - To switch back to the published npm version:
        npm unlink -g @jeanibarz/knowledge-base-mcp-server
        npm i -g @jeanibarz/knowledge-base-mcp-server@latest

EOF
