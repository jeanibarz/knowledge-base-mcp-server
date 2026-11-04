#!/usr/bin/env bash
# Remove the SwiftBar menu-bar plugin. Deliberately does NOT touch the
# launchd service, the auth token, mcp_config.json, or kb.config.yaml —
# uninstall only removes the menubar UI.
set -euo pipefail

ENV_FILE="${KB_MENUBAR_ENV:-$HOME/.config/kb/menubar.env}"

PLUGIN_DST="${KB_PLUGIN_DST:-$HOME/Library/Application Support/SwiftBar/Plugins}"

# Safety: the plugin dir must never be inside a repo checkout — an earlier
# version derived it from $0 and deleted the repo's own script files.
case "$PLUGIN_DST" in
  */plugins/swiftbar|*/.git/*|*/workspace/*) echo "uninstall: refusing — PLUGIN_DST looks like a repo path: $PLUGIN_DST" >&2; exit 1 ;;
esac

removed=0
# -L catches the symlink installed by install.sh even if its target moved.
for f in "$PLUGIN_DST/kb-mcp.10s.sh" "$ENV_FILE"; do
  [[ -e $f || -L $f ]] && { rm -f "$f"; removed=1; }
done
# Legacy layouts: helpers copied next to the plugin or under helpers/ —
# anything executable under the plugin dir gets run by SwiftBar.
rm -rf "$PLUGIN_DST/helpers" "$PLUGIN_DST/kb-mcp-rebuild.sh" "$PLUGIN_DST/kb-mcp-uninstall.sh"

if [[ $removed -eq 1 ]]; then
  echo "uninstall: removed kb-mcp plugin files and $(basename "$ENV_FILE")"
else
  echo "uninstall: nothing to remove — plugin files and $(basename "$ENV_FILE") already absent"
fi
echo "uninstall: SwiftBar drops the menu item on its next refresh (~10s)"
echo "uninstall: server untouched — $HOME/Library/LaunchAgents/ai.knowledge-base.mcp.plist is still loaded"
