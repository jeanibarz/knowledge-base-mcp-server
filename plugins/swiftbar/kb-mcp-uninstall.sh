#!/usr/bin/env bash
# Self-uninstall, invoked from the SwiftBar menu (Advanced → Uninstall).
# Confirms via a native dialog, then delegates to the repo's uninstall.sh;
# if the checkout is gone it removes just its own plugin files + env.
# The MCP server itself is never touched.
set -uo pipefail

ENV_FILE="${KB_MENUBAR_ENV:-$HOME/.config/kb/menubar.env}"
# shellcheck source=/dev/null
[[ -f $ENV_FILE ]] && source "$ENV_FILE"

REPO="${KB_MCP_REPO:-$HOME/workspace/knowledge-base-mcp-server}"
PLUGIN_DST="${KB_PLUGIN_DST:-$HOME/Library/Application Support/SwiftBar/Plugins}"
REPO_UNINSTALL="$REPO/plugins/swiftbar/uninstall.sh"

answer="$(osascript -e 'display dialog "Remove the KB MCP menu-bar plugin?\n\nThe MCP server keeps running — only the menu item and its files are removed." buttons {"Cancel", "Remove"} default button "Cancel" cancel button "Cancel" with title "KB MCP"' 2>/dev/null || true)"
[[ "$answer" == *"Remove"* ]] || exit 0

if [[ -x "$REPO_UNINSTALL" ]]; then
  env KB_PLUGIN_DST="$PLUGIN_DST" KB_MENUBAR_ENV="$ENV_FILE" "$REPO_UNINSTALL" \
    || osascript -e 'display dialog "uninstall.sh failed — see Terminal/logs." buttons {"OK"} default button "OK" with title "KB MCP"' >/dev/null 2>&1
else
  rm -f "$PLUGIN_DST/kb-mcp.10s.sh" "$ENV_FILE"
fi

osascript -e 'display notification "KB MCP menu-bar plugin removed (server untouched)" with title "KB MCP"' 2>/dev/null || true
