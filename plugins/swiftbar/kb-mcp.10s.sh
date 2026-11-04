#!/usr/bin/env bash
# <xbar.title>KB MCP</xbar.title>
# <xbar.version>v1.0</xbar.version>
# <xbar.author>Svend Gundestrup</xbar.author>
# <xbar.desc>Status + control for the launchd-managed knowledge-base MCP server</xbar.desc>
# <xbar.dependencies>bash,curl</xbar.dependencies>

# Paths are resolved at install time into ~/.config/kb/menubar.env —
# re-run plugins/swiftbar/install.sh after moving the repo or changing the port.
ENV_FILE="${KB_MENUBAR_ENV:-$HOME/.config/kb/menubar.env}"
# shellcheck source=/dev/null
[[ -f $ENV_FILE ]] && source "$ENV_FILE"

LABEL="${KB_MCP_LABEL:-ai.knowledge-base.mcp}"
PORT="${KB_MCP_PORT:-8090}"
BIND="${KB_MCP_BIND:-127.0.0.1}"
PLIST="${KB_MCP_PLIST:-$HOME/Library/LaunchAgents/${LABEL}.plist}"
LOG_ERR="${KB_MCP_LOG_ERR:-$HOME/Library/Logs/knowledge-base-mcp.err.log}"
LOG_OUT="${KB_MCP_LOG_OUT:-$HOME/Library/Logs/knowledge-base-mcp.out.log}"
MCP_CFG="${KB_MCP_CONFIG:-$HOME/.config/devin/mcp_config.json}"
DOMAIN="gui/$(id -u)/${LABEL}"
HEALTH="http://${BIND}:${PORT}/health"

# Helpers live in the repo checkout, NOT in the plugin dir: SwiftBar
# recursively executes every executable file it finds there.
REPO="${KB_MCP_REPO:-$HOME/workspace/knowledge-base-mcp-server}"
HELPER="$REPO/plugins/swiftbar/kb-mcp-rebuild.sh"
UNINSTALL="$REPO/plugins/swiftbar/kb-mcp-uninstall.sh"
UPDATER="$REPO/plugins/swiftbar/update.sh"

# Remote version check — throttled to once per 6h, silent on any failure.
REMOTE_VER_URL="https://raw.githubusercontent.com/jeanibarz/knowledge-base-mcp-server/main/plugins/swiftbar/VERSION"
CACHE="$HOME/.config/kb/.update-check"
LOCAL_VER="$(cat "$REPO/plugins/swiftbar/VERSION" 2>/dev/null || echo 0)"
NOW=$(date +%s); LAST=0
[[ -f $CACHE ]] && LAST=$(cat "$CACHE" 2>/dev/null || echo 0)
REMOTE_VER=""
if (( NOW - LAST > 21600 )); then
  REMOTE_VER="$(curl -fsSL -m 3 "$REMOTE_VER_URL" 2>/dev/null || true)"
  mkdir -p "$(dirname "$CACHE")" 2>/dev/null || true
  echo "$NOW" > "$CACHE" 2>/dev/null || true
  [[ -n $REMOTE_VER ]] && echo "$REMOTE_VER" > "$CACHE.ver" 2>/dev/null || true
fi
[[ -z $REMOTE_VER && -f $CACHE.ver ]] && REMOTE_VER="$(cat "$CACHE.ver" 2>/dev/null || true)"
UPDATE_AVAIL=0
if [[ -n $REMOTE_VER && -n $LOCAL_VER ]] && [[ "$REMOTE_VER" != "$LOCAL_VER" ]] && \
   [[ "$(printf '%s\n%s\n' "$LOCAL_VER" "$REMOTE_VER" | sort -V | tail -1)" == "$REMOTE_VER" ]]; then
  UPDATE_AVAIL=1
fi

state="$(launchctl print "$DOMAIN" 2>/dev/null | awk -F' = ' '$1 ~ /state/ {print $2; exit}')"
pid="$(launchctl print "$DOMAIN" 2>/dev/null | awk -F' = ' '$1 ~ /pid/ {print $2; exit}')"
health="$(curl -s -m 2 "$HEALTH" 2>/dev/null)"

if [[ "$state" == "running" && "$health" == *'"ok"'* ]]; then
  echo "KB ● | color=#2e7d32"
else
  echo "KB ● | color=#c62828"
fi
echo "---"
echo "state: ${state:-stopped}  pid: ${pid:-—} | size=11 color=gray"
echo "health: ${health:-unreachable} | size=11 color=gray"
echo "---"
echo "Rebuild + restart | bash=$HELPER terminal=true refresh=true"
echo "Restart | bash=/bin/launchctl param1=kickstart param2=-k param3=$DOMAIN terminal=false refresh=true"
echo "Stop | bash=/bin/launchctl param1=bootout param2=$DOMAIN terminal=false refresh=true"
echo "Start | bash=/bin/launchctl param1=bootstrap param2=gui/$(id -u) param3=$PLIST terminal=false refresh=true"
echo "---"
echo "Open error log | bash=/usr/bin/open param1=-a param2=Console param3=$LOG_ERR terminal=false"
echo "Open out log | bash=/usr/bin/open param1=-a param2=Console param3=$LOG_OUT terminal=false"
echo "Edit Devin MCP config | bash=/usr/bin/open param1=-t param2=$MCP_CFG terminal=false"
echo "---"
echo "Health endpoint | href=$HEALTH"
echo "Advanced"
if [[ $UPDATE_AVAIL -eq 1 ]]; then
  echo "-- Update available: $LOCAL_VER → $REMOTE_VER | color=#c62828"
  echo "-- Run update | bash=$UPDATER terminal=true refresh=true"
fi
echo "-- Check for updates | bash=/bin/rm param1=-f param2=$CACHE terminal=false refresh=true"
echo "-- Uninstall plugin… | bash=$UNINSTALL terminal=false refresh=true"
