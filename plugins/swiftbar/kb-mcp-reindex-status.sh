#!/usr/bin/env bash
# Print `kb reindex status` — the contextual-preface progress ledger —
# in a Terminal window. Invoked from the SwiftBar "Reindex status…" menu
# action; also usable directly from a shell.
ENV_FILE="${KB_MENUBAR_ENV:-$HOME/.config/kb/menubar.env}"
# shellcheck source=/dev/null
[[ -f $ENV_FILE ]] && source "$ENV_FILE"

REPO="${KB_MCP_REPO:-$HOME/workspace/knowledge-base-mcp-server}"
NODE="${KB_MCP_NODE:-node}"

# The CLI resolves its index dir from env; mirror the launchd service's
# config (resolved into menubar.env by install.sh) so the report covers
# the same corpus the running server sees.
[[ -n ${KB_KB_ROOT:-} ]] && export KNOWLEDGE_BASES_ROOT_DIR="$KB_KB_ROOT"
[[ -n ${KB_FAISS_INDEX_PATH:-} ]] && export FAISS_INDEX_PATH="$KB_FAISS_INDEX_PATH"

"$NODE" "$REPO/build/cli.js" reindex status
echo
read -r -n 1 -p "press any key to close…" || true
