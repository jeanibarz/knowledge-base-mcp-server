#!/usr/bin/env bash
# <xbar.title>KB MCP</xbar.title>
# <xbar.version>v1.1</xbar.version>
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
# NOSONAR: cleartext http is by design — /health is unauthenticated and the
# server binds loopback (RFC 008 §6.8); nothing sensitive crosses the wire.
HEALTH="http://${BIND}:${PORT}/health" # NOSONAR

# Helpers live in the repo checkout, NOT in the plugin dir: SwiftBar
# recursively executes every executable file it finds there.
REPO="${KB_MCP_REPO:-$HOME/workspace/knowledge-base-mcp-server}"
HELPER="$REPO/plugins/swiftbar/kb-mcp-rebuild.sh"
STATUS_HELPER="$REPO/plugins/swiftbar/kb-mcp-reindex-status.sh"
UNINSTALL="$REPO/plugins/swiftbar/kb-mcp-uninstall.sh"
UPDATER="$REPO/plugins/swiftbar/update.sh"

# Remote version check — tracks the highest vetted swiftbar/v* release tag,
# falling back to main's VERSION until the first tag is cut. Throttled to once
# per 6h, silent on any failure.
REPO_SLUG="jeanibarz/knowledge-base-mcp-server"
TAGS_API="https://api.github.com/repos/${REPO_SLUG}/tags?per_page=100"
REMOTE_VER_FALLBACK_URL="https://raw.githubusercontent.com/${REPO_SLUG}/main/plugins/swiftbar/VERSION"
CACHE="$HOME/.config/kb/.update-check"
LOCAL_VER="$(cat "$REPO/plugins/swiftbar/VERSION" 2>/dev/null || echo 0)"
NOW=$(date +%s); LAST=0
[[ -f $CACHE ]] && LAST=$(cat "$CACHE" 2>/dev/null || echo 0)
REMOTE_VER=""
if (( NOW - LAST > 21600 )); then
  # Highest swiftbar/v<semver> release tag (server-wide vX.Y.Z tags ignored);
  # fall back to main's VERSION until the first swiftbar/ tag is cut.
  # No -L: both endpoints answer directly, and refusing redirects keeps a
  # poisoned/MITM'd 3xx from steering the check to a cleartext host.
  REMOTE_VER="$(curl -fsS -m 3 "$TAGS_API" 2>/dev/null \
    | grep -oE '"swiftbar/v[0-9]+\.[0-9]+\.[0-9]+"' \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' \
    | sort -V | tail -1 || true)"
  [[ -z $REMOTE_VER ]] && REMOTE_VER="$(curl -fsS -m 3 "$REMOTE_VER_FALLBACK_URL" 2>/dev/null || true)"
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
health="$(curl -s -m 2 "$HEALTH" 2>/dev/null)" # NOSONAR

# --- indexing activity (local files only — no auth, no HTTP) ------------------
# Durable signals under the FAISS index dir (src/write-lock.ts, reindex-runner.ts):
#   .reindex.run.json        — `kb reindex` run marker: pid + started_at (+ host).
#   models/*/.kb-write.lock  — write lock held by EVERY mutating index op
#     (MCP reindex_knowledge_base, watcher updateIndex, add/delete_document).
#     Its .owner.json sibling names the argv doing the write. proper-lockfile
#     heartbeats the lock mtime every 5s (stale: 10s) — a lock older than ~15s
#     is an abandoned remnant, not live work.
INDEX_DIR="${KB_FAISS_INDEX_PATH:-${KB_KB_ROOT:-$HOME/knowledge_bases}/.faiss}"
BUSY=0
INDEX_LINE=""
THIS_HOST="$(hostname)"
run_state="$INDEX_DIR/.reindex.run.json"
if [[ -f $run_state ]]; then
  run_pid="$(grep -oE '"pid": *[0-9]+' "$run_state" | head -1 | grep -oE '[0-9]+')"
  run_host="$(grep -oE '"hostname": *"[^"]+"' "$run_state" | head -1 | cut -d'"' -f4)"
  if [[ -n $run_pid && ( -z $run_host || $run_host == "$THIS_HOST" ) ]] \
     && kill -0 "$run_pid" 2>/dev/null; then
    BUSY=1
    run_started="$(grep -oE '"started_at": *"[^"]+"' "$run_state" | head -1 | cut -d'"' -f4)"
    INDEX_LINE="reindex: IN PROGRESS — pid $run_pid, started ${run_started:-unknown}"
  fi
fi
if [[ $BUSY -eq 0 && -d $INDEX_DIR ]]; then
  now_s=$(date +%s)
  for lock in "$INDEX_DIR"/models/*/.kb-write.lock "$INDEX_DIR/.kb-write.lock"; do
    [[ -e $lock ]] || continue
    lock_mtime="$(stat -f %m "$lock" 2>/dev/null || echo 0)"
    (( now_s - lock_mtime > 15 )) && continue
    BUSY=1
    owner="${lock}.owner.json"
    ocmd=""
    if [[ -f $owner ]]; then
      ohost="$(grep -oE '"hostname": *"[^"]+"' "$owner" | head -1 | cut -d'"' -f4)"
      [[ -z $ohost || $ohost == "$THIS_HOST" ]] \
        && ocmd="$(grep -oE '"command": *"[^"]*"' "$owner" | head -1 | cut -d'"' -f4)"
    fi
    # owner command is a full argv ("<node> <repo>/build/cli.js reindex …") —
    # drop the binary and absolutize to repo-relative so it fits the menu.
    ocmd="${ocmd#* }"; ocmd="${ocmd#"$REPO"/}"; ocmd="${ocmd#"$HOME"/}"
    [[ ${#ocmd} -gt 80 ]] && ocmd="${ocmd:0:77}…"
    INDEX_LINE="indexing: ${ocmd:-write in progress}"
    break
  done
fi

if [[ "$state" == "running" && "$health" == *'"ok"'* ]]; then
  if [[ $BUSY -eq 1 ]]; then
    echo "KB ◐ | color=#f9a825"
  else
    echo "KB ● | color=#2e7d32"
  fi
else
  echo "KB ● | color=#c62828"
fi
echo "---"
echo "state: ${state:-stopped}  pid: ${pid:-—} | size=11 color=gray"
echo "health: ${health:-unreachable} | size=11 color=gray" # NOSONAR
if [[ -n $INDEX_LINE ]]; then
  echo "$INDEX_LINE | size=11 color=#f9a825"
else
  echo "index: idle | size=11 color=gray"
fi
echo "---"
echo "Rebuild + restart | bash=$HELPER terminal=true refresh=true"
echo "Reindex status… | bash=$STATUS_HELPER terminal=true refresh=true"
echo "Restart | bash=/bin/launchctl param1=kickstart param2=-k param3=$DOMAIN terminal=false refresh=true"
echo "Stop | bash=/bin/launchctl param1=bootout param2=$DOMAIN terminal=false refresh=true"
echo "Start | bash=/bin/launchctl param1=bootstrap param2=gui/$(id -u) param3=$PLIST terminal=false refresh=true"
echo "---"
echo "Open error log | bash=/usr/bin/open param1=-a param2=Console param3=$LOG_ERR terminal=false"
echo "Open out log | bash=/usr/bin/open param1=-a param2=Console param3=$LOG_OUT terminal=false"
echo "Edit Devin MCP config | bash=/usr/bin/open param1=-t param2=$MCP_CFG terminal=false"
echo "---"
echo "Health endpoint | href=$HEALTH" # NOSONAR
echo "Advanced"
if [[ $UPDATE_AVAIL -eq 1 ]]; then
  echo "-- Update available: $LOCAL_VER → $REMOTE_VER | color=#c62828"
  echo "-- Run update | bash=$UPDATER terminal=true refresh=true"
fi
echo "-- Check for updates | bash=/bin/rm param1=-f param2=$CACHE terminal=false refresh=true"
echo "-- Uninstall plugin… | bash=$UNINSTALL terminal=false refresh=true"
