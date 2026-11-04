#!/usr/bin/env bash
# Install the SwiftBar menu-bar plugin for the launchd-managed
# knowledge-base MCP server.
#
# Preflight (all must pass BEFORE anything is installed):
#   1. SwiftBar.app present
#   2. launchd service loaded and running
#   3. /health returns ok — the server is verified working, not just alive
#
# Config resolution precedence:
#   launchd plist > ~/.config/devin/mcp_config.json > ~/.config/kb/kb.config.yaml > defaults
#
# Writes ~/.config/kb/menubar.env (no secrets — the bearer token is NOT
# needed; the plugin only reads the unauthenticated /health endpoint).
set -euo pipefail

LABEL="${KB_MCP_LABEL:-ai.knowledge-base.mcp}"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
MCP_CFG="$HOME/.config/devin/mcp_config.json"
KBYAML="$HOME/.config/kb/kb.config.yaml"
ENV_FILE="${KB_MENUBAR_ENV:-$HOME/.config/kb/menubar.env}"
PLUGIN_DST="${KB_PLUGIN_DST:-$HOME/Library/Application Support/SwiftBar/Plugins}"
SWIFTBAR_APP="${KB_SWIFTBAR_APP:-/Applications/SwiftBar.app}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "install: error: $*" >&2; exit 1; }
info() { echo "install: $*"; }

# --- preflight 1: SwiftBar -------------------------------------------------
# Pass --install-swiftbar (or KB_INSTALL_SWIFTBAR=1) to install it via
# Homebrew automatically instead of just outlining the suggestion.
if [[ ! -d "$SWIFTBAR_APP" && ! -d "$HOME/Applications/SwiftBar.app" ]]; then
  if [[ "${1:-}" == "--install-swiftbar" || "${KB_INSTALL_SWIFTBAR:-}" == "1" ]]; then
    command -v brew >/dev/null \
      || die "--install-swiftbar given but Homebrew is not installed — get it from https://brew.sh first"
    info "installing SwiftBar via Homebrew…"
    brew install --cask swiftbar
  else
    cat >&2 <<EOF
install: error: SwiftBar not found — it is required for the menu bar icon.

  Install it via Homebrew (recommended):
      brew install --cask swiftbar

  Or re-run this installer with the flag and it will do it for you:
      plugins/swiftbar/install.sh --install-swiftbar

  Manual alternative: https://github.com/swiftbar/SwiftBar/releases
EOF
    exit 1
  fi
fi

# --- resolve config (read-only) -------------------------------------------
PLIST_JSON="$(plutil -convert json -o - "$PLIST" 2>/dev/null || echo '{}')"
MCFG_JSON="$(cat "$MCP_CFG" 2>/dev/null || echo '{}')"

# shellcheck disable=SC2016 # single quotes are literal JS, not an unexpanded expr
RESOLVED="$(PLIST_JSON="$PLIST_JSON" MCFG_JSON="$MCFG_JSON" \
  node -e '
const fs = require("fs");
const home = process.env.HOME;
const plist = JSON.parse(process.env.PLIST_JSON);
const mcfg = JSON.parse(process.env.MCFG_JSON);
const yamlPath = process.argv[1];
const out = {};

// 1. launchd plist — authoritative when present (the live service config).
const env = plist.EnvironmentVariables || {};
if (env.MCP_PORT) out.PORT = env.MCP_PORT;
if (env.MCP_BIND_ADDR) out.BIND = env.MCP_BIND_ADDR;
const args = plist.ProgramArguments || [];
const idx = args.find((a) => /build\/index\.js$/.test(a));
if (idx) out.REPO = idx.replace(/\/build\/index\.js$/, "");

// 2. devin mcp_config.json — url gives bind/port (http form); stdio args
//    give the repo path; stdio env gives kb vars for completeness.
const srv = (mcfg.mcpServers || {})["knowledge-base"] || {};
if (srv.url) {
  try {
    const u = new URL(srv.url);
    out.PORT = out.PORT || u.port;
    out.BIND = out.BIND || u.hostname;
  } catch {}
}
if (!out.REPO && Array.isArray(srv.args)) {
  const a = srv.args.find((x) => /build\/index\.js$/.test(x));
  if (a) out.REPO = a.replace(/\/build\/index\.js$/, "");
}

// 3. kb.config.yaml — flat "KEY: value" lines; used for trigger/provider
//    documentation parity only (menubar plugin does not need them).
try {
  const y = fs.readFileSync(yamlPath, "utf8");
  for (const line of y.split("\n")) {
    const m = line.match(/^([A-Z_]+):\s*(.+?)\s*$/);
    if (m && !(m[1] in out)) out["YAML_" + m[1]] = m[2];
  }
} catch {}

// 4. env overrides + defaults (KB_MCP_* env wins for testing/off-standard setups).
out.LABEL = process.env.KB_MCP_LABEL || "ai.knowledge-base.mcp";
out.PORT = process.env.KB_MCP_PORT || out.PORT || "8090";
out.BIND = process.env.KB_MCP_BIND || out.BIND || "127.0.0.1";

for (const [k, v] of Object.entries(out)) {
  console.log(`${k}=${JSON.stringify(v)}`);
}
' "$KBYAML")"

PORT="$(echo "$RESOLVED" | sed -n 's/^PORT="\(.*\)"$/\1/p')"
BIND="$(echo "$RESOLVED" | sed -n 's/^BIND="\(.*\)"$/\1/p')"
REPO="$(echo "$RESOLVED" | sed -n 's/^REPO="\(.*\)"$/\1/p')"
REPO="${REPO:-$HOME/workspace/knowledge-base-mcp-server}"

[[ -d "$REPO/.git" ]] || die "could not resolve repo checkout (got '$REPO') — run install.sh from inside the repo or fix ProgramArguments in $PLIST"

# --- preflight 2: service loaded + running ---------------------------------
launchctl print "gui/$(id -u)/${LABEL}" >/dev/null 2>&1 \
  || die "service '${LABEL}' not loaded — set up a launchd HTTP agent first (see plugins/swiftbar/README.md)"
state="$(launchctl print "gui/$(id -u)/${LABEL}" | awk -F' = ' '$1 ~ /state/ {print $2; exit}')"
[[ "$state" == "running" ]] \
  || die "service loaded but state='${state:-unknown}' — start it: launchctl kickstart -k gui/$(id -u)/${LABEL}"

# --- preflight 3: /health ok ------------------------------------------------
health="$(curl -s -m 3 "http://${BIND}:${PORT}/health" || true)"
[[ "$health" == *'"ok"'* ]] \
  || die "no ok from http://${BIND}:${PORT}/health (got: ${health:-unreachable}) — is the server really on ${PORT}?"

info "preflight ok: ${LABEL} running, http://${BIND}:${PORT}/health -> ${health}"
info "resolved: repo=$REPO port=$PORT bind=$BIND label=$LABEL"

# --- install (only reached when every check above passed) ------------------
mkdir -p "$PLUGIN_DST" "$(dirname "$ENV_FILE")"
# Values are single-quoted: this file is sourced by the plugin scripts, and
# unquoted paths containing spaces or shell metachars would break the source.
q() { printf '%q' "$1"; }
cat > "$ENV_FILE" <<EOF
# Generated by plugins/swiftbar/install.sh $(date +%Y-%m-%d) — re-run the
# installer after moving the repo, changing the port, or renaming the service.
KB_MCP_LABEL=$(q "$LABEL")
KB_MCP_REPO=$(q "$REPO")
KB_MCP_PORT=$(q "$PORT")
KB_MCP_BIND=$(q "$BIND")
KB_MCP_PLIST=$(q "$PLIST")
KB_MCP_LOG_ERR=$(q "$HOME/Library/Logs/knowledge-base-mcp.err.log")
KB_MCP_LOG_OUT=$(q "$HOME/Library/Logs/knowledge-base-mcp.out.log")
KB_MCP_CONFIG=$(q "$MCP_CFG")
KB_PLUGIN_DST=$(q "$PLUGIN_DST")
EOF

[[ -f "$SCRIPT_DIR/kb-mcp.10s.sh" ]] || die "plugin source missing: $SCRIPT_DIR/kb-mcp.10s.sh — restore it (git checkout -- plugins/swiftbar/) before installing"

# Only the plugin file itself goes in the plugin dir — as a SYMLINK to the
# repo copy, so repo updates take effect on the next refresh with no
# reinstall. Helpers are invoked from the repo checkout via KB_MCP_REPO —
# SwiftBar recursively executes EVERY executable file under the plugin dir,
# so a copied helper would be run as a plugin itself.
ln -sf "$SCRIPT_DIR/kb-mcp.10s.sh" "$PLUGIN_DST/kb-mcp.10s.sh"
# Clean up legacy layouts (top-level helpers, helpers/ subdir, stale copies).
rm -rf "$PLUGIN_DST/helpers" "$PLUGIN_DST/kb-mcp-rebuild.sh" "$PLUGIN_DST/kb-mcp-uninstall.sh"
defaults write com.ameba.SwiftBar PluginsDirectory "$PLUGIN_DST" 2>/dev/null || true

if pgrep -x SwiftBar >/dev/null 2>&1; then
  info "SwiftBar already running — plugin picked up within ~10s"
else
  open -a SwiftBar && info "SwiftBar launched"
fi

info "done — 'KB ●' should appear in the menu bar"
