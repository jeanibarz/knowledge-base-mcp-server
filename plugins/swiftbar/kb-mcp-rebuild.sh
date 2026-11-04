#!/usr/bin/env bash
# Rebuild build/ and restart the launchd MCP server. Invoked from the
# SwiftBar "Rebuild + restart" menu action (opens a Terminal so output is
# visible); also usable directly from a shell.
set -e

ENV_FILE="${KB_MENUBAR_ENV:-$HOME/.config/kb/menubar.env}"
# shellcheck source=/dev/null
[[ -f $ENV_FILE ]] && source "$ENV_FILE"

REPO="${KB_MCP_REPO:-$HOME/workspace/knowledge-base-mcp-server}"
LABEL="${KB_MCP_LABEL:-ai.knowledge-base.mcp}"
PORT="${KB_MCP_PORT:-8090}"
BIND="${KB_MCP_BIND:-127.0.0.1}"

cd "$REPO"
echo "== npm run build ($REPO) =="
npm run build
echo
echo "== launchctl kickstart =="
/bin/launchctl kickstart -k "gui/$(id -u)/${LABEL}"
sleep 2
echo "== health =="
curl -s -m 5 "http://${BIND}:${PORT}/health"
echo
