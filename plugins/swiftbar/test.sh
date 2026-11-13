#!/usr/bin/env bash
# Self-contained test harness for plugins/swiftbar/{install,uninstall}.sh
# Uses only temp dirs + env overrides — never touches the real SwiftBar
# plugin dir, menubar.env, or the live launchd service.
# shellcheck disable=SC2015,SC2034  # `run && check || check` is intentional;
                                    # $out is consumed inside eval'd checks.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d /tmp/kb-swiftbar-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0

ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

FAKE_APP="$TMP/SwiftBar.app";            mkdir -p "$FAKE_APP"
DST="$TMP/swiftbar-plugins"
ENVF="$TMP/menubar.env"
LABEL_OK="ai.knowledge-base.mcp"
LABEL_BAD="ai.kb.does-not-exist"

run() { env "$@" "$HERE/install.sh" 2>&1; }

echo "== preflight rejects =="
out=$(run KB_MCP_LABEL="$LABEL_BAD" KB_SWIFTBAR_APP="$TMP/nonexistent.app" KB_PLUGIN_DST="$DST" KB_MENUBAR_ENV="$ENVF")
check "no SwiftBar -> brew outline shown" "echo \"\$out\" | grep -q 'brew install --cask swiftbar'"
run KB_MCP_LABEL="$LABEL_BAD" KB_SWIFTBAR_APP="$TMP/nonexistent.app" KB_PLUGIN_DST="$DST" KB_MENUBAR_ENV="$ENVF" >/dev/null 2>&1
check "no SwiftBar -> nonzero exit" "[[ \$? -ne 0 ]]"

run KB_MCP_LABEL="$LABEL_BAD" KB_SWIFTBAR_APP="$FAKE_APP" KB_PLUGIN_DST="$DST" KB_MENUBAR_ENV="$ENVF" >/dev/null 2>&1
check "service not loaded -> nonzero exit" "[[ \$? -ne 0 ]]"
check "service not loaded -> no menubar.env" "[[ ! -f \"$ENVF\" ]]"

run KB_MCP_LABEL="$LABEL_OK" KB_SWIFTBAR_APP="$FAKE_APP" KB_PLUGIN_DST="$DST" KB_MENUBAR_ENV="$ENVF" KB_MCP_PORT=1 >/dev/null 2>&1
check "unhealthy endpoint -> nonzero exit" "[[ \$? -ne 0 ]]"

echo "== happy path (real service) =="
run KB_MCP_LABEL="$LABEL_OK" KB_SWIFTBAR_APP="$FAKE_APP" KB_PLUGIN_DST="$DST" KB_MENUBAR_ENV="$ENVF" >/dev/null 2>&1 \
  && check "install exit 0" true || check "install exit 0" false
check "menubar.env written" "[[ -f \"$ENVF\" ]] && grep -q 'KB_MCP_REPO=' \"$ENVF\""
check "no secrets in menubar.env" "! grep -qi 'token\\|Bearer' \"$ENVF\""
check "plugin installed as symlink to repo copy" "[[ -L \"$DST/kb-mcp.10s.sh\" ]] && readlink \"$DST/kb-mcp.10s.sh\" | grep -q 'plugins/swiftbar/kb-mcp.10s.sh\$'"
# SwiftBar executes EVERY executable it finds under the plugin dir,
# recursively — simulate the host's execution model: exactly ONE
# executable anywhere below the plugin dir, and it's the plugin itself.
check "exactly one executable in plugin dir (synthetic SwiftBar scan)" \
  "[[ \"\$(find \"$DST\" -perm +111 \\( -type f -o -type l \\) | wc -l | tr -d ' ')\" == 1 ]] && find \"$DST\" -perm +111 \\( -type f -o -type l \\) | grep -q 'kb-mcp.10s.sh\$'"
check "plugin executable" "[[ -x \"$DST/kb-mcp.10s.sh\" ]]"
out=$(KB_MENUBAR_ENV="$ENVF" "$DST/kb-mcp.10s.sh")
check "plugin renders menubar line" "echo \"\$out\" | head -1 | grep -q '^KB ●'"
check "plugin shows running state" "echo \"\$out\" | grep -q 'state: running'"
check "plugin actions present" "echo \"\$out\" | grep -q 'Rebuild + restart' && echo \"\$out\" | grep -q 'Restart'"
check "uninstall item in Advanced submenu" "echo \"\$out\" | grep -q 'Uninstall plugin' && echo \"\$out\" | grep -q 'Advanced'"

echo "== idempotent reinstall =="
run KB_MCP_LABEL="$LABEL_OK" KB_SWIFTBAR_APP="$FAKE_APP" KB_PLUGIN_DST="$DST" KB_MENUBAR_ENV="$ENVF" >/dev/null 2>&1 \
  && check "second install exit 0" true || check "second install exit 0" false

echo "== uninstall =="
env KB_PLUGIN_DST="$DST" KB_MENUBAR_ENV="$ENVF" "$HERE/uninstall.sh" >/dev/null 2>&1 \
  && check "uninstall exit 0" true || check "uninstall exit 0" false
check "plugin files removed" "[[ ! -f \"$DST/kb-mcp.10s.sh\" && ! -d \"$DST/helpers\" && \"\$(find \"$DST\" -type f -perm +111 | wc -l | tr -d ' ')\" == 0 ]]"
check "menubar.env removed" "[[ ! -f \"$ENVF\" ]]"
check "service untouched (still running)" "launchctl print gui/$(id -u)/$LABEL_OK 2>/dev/null | grep -q 'state = running'"
out=$(env KB_PLUGIN_DST="$DST" KB_MENUBAR_ENV="$ENVF" "$HERE/uninstall.sh" 2>&1)
check "second uninstall -> exit 0 + honest 'nothing to remove'" "[[ \$? -eq 0 || 1 ]] && echo \"\$out\" | grep -q 'nothing to remove'"

echo "== update machinery (stubbed network) =="
# Fake curl: serves a remote VERSION file, or fails. PATH shim — no real network.
mkdir -p "$TMP/bin" "$TMP/home" "$TMP/fakerepo/plugins/swiftbar"
printf '1.0.0\n' > "$TMP/fakerepo/plugins/swiftbar/VERSION"
cp "$HERE/kb-mcp.10s.sh" "$TMP/fakerepo/plugins/swiftbar/"
cat > "$TMP/bin/curl" <<STUB
#!/bin/sh
case " \$* " in
  *VERSION*) cat "$TMP/remote-version" ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/curl"
printf '%s\n' "KB_MCP_REPO=$TMP/fakerepo" "KB_MCP_PORT=8090" "KB_MCP_BIND=127.0.0.1" "KB_MCP_LABEL=$LABEL_OK" > "$ENVF"

printf '2.0.0\n' > "$TMP/remote-version"
out=$(env -i HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF" "$TMP/fakerepo/plugins/swiftbar/kb-mcp.10s.sh" 2>/dev/null)
check "remote newer -> Update available shown" "echo \"\$out\" | grep -q 'Update available'"
check "remote newer -> Run update action" "echo \"\$out\" | grep -q 'Run update'"
check "cache timestamp written" "[[ -f \"\$TMP/home/.config/kb/.update-check\" ]]"

printf '1.0.0\n' > "$TMP/remote-version"; rm -f "$TMP/home/.config/kb/.update-check"*
out=$(env -i HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF" "$TMP/fakerepo/plugins/swiftbar/kb-mcp.10s.sh" 2>/dev/null)
check "same version -> no update banner" "! echo \"\$out\" | grep -q 'Update available'"
check "Check-for-updates always present" "echo \"\$out\" | grep -q 'Check for updates'"

rm -f "$TMP/bin/curl"; rm -f "$TMP/home/.config/kb/.update-check"*
out=$(env -i HOME="$TMP/home" PATH="/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF" "$TMP/fakerepo/plugins/swiftbar/kb-mcp.10s.sh" 2>/dev/null)
check "offline -> silent, still renders KB line" "echo \"\$out\" | head -1 | grep -q '^KB' && ! echo \"\$out\" | grep -q 'Update available'"

echo "== update.sh sanity =="
check "update.sh fetch failure exits nonzero" "! env HOME=\"$TMP/home\" KB_MENUBAR_ENV=\"$ENVF\" PATH=/usr/bin:/bin \"$HERE/update.sh\" bogus-tag 2>/dev/null"
check "update.sh syntax valid" "bash -n \"$HERE/update.sh\""

echo "== release-tag pinning (issue #1114) =="
# Stub curl: GitHub tags API returns swiftbar/v2.0.0 (plus a decoy server-wide
# v9.9.9 that must be ignored); a main VERSION fetch would serve the OLD 1.0.0.
# The passive check must report 2.0.0 (from the tag), proving it pins to the
# swiftbar/v* release and not to main.
cat > "$TMP/bin/curl" <<STUB
#!/bin/sh
case " \$* " in
  *api.github.com*tags*) printf '%s\n' '[{"name":"v9.9.9"},{"name":"swiftbar/v1.0.0"},{"name":"swiftbar/v2.0.0"}]' ;;
  *main*VERSION*) printf '1.0.0\n' ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/curl"; rm -f "$TMP/home/.config/kb/.update-check"*
out=$(env -i HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF" "$TMP/fakerepo/plugins/swiftbar/kb-mcp.10s.sh" 2>/dev/null)
# Banner shows 2.0.0 only if the tag (not main's 1.0.0) drove the check; a
# failed tag resolution would fall back to main 1.0.0 == local -> no banner.
check "passive check pins to latest swiftbar/v* tag" "echo \"\$out\" | grep -q 'Update available' && echo \"\$out\" | grep -q '2[.]0[.]0'"
check "passive check ignores non-swiftbar server tags" "! echo \"\$out\" | grep -q '9[.]9[.]9'"

# Stub curl: tags API -> swiftbar/v1.0.0; log every raw-content URL then fail so
# update.sh aborts at the first fetch (before install). Proves the default (no
# tag arg) pulls from the swiftbar/v1.0.0 ref, not from main.
cat > "$TMP/bin/curl" <<STUB
#!/bin/sh
for a in "\$@"; do case "\$a" in https://raw.githubusercontent.com/*) echo "\$a" >> "$TMP/fetch.log" ;; esac; done
case " \$* " in
  *api.github.com*tags*) printf '%s\n' '[{"name":"swiftbar/v1.0.0"}]' ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/curl"; rm -f "$TMP/fetch.log"
env HOME="$TMP/home" KB_MENUBAR_ENV="$ENVF" PATH="$TMP/bin:/usr/bin:/bin" "$HERE/update.sh" >/dev/null 2>&1 || true
check "update.sh default pins to latest swiftbar/v* tag" "grep -q '/swiftbar/v1.0.0/plugins/swiftbar/' \"$TMP/fetch.log\""
check "update.sh default does not pull from main" "! grep -q '/main/plugins/swiftbar/' \"$TMP/fetch.log\""

# No swiftbar/* tags exist -> update.sh must fall back to main (bootstrap).
cat > "$TMP/bin/curl" <<STUB
#!/bin/sh
for a in "\$@"; do case "\$a" in https://raw.githubusercontent.com/*) echo "\$a" >> "$TMP/fetch.log" ;; esac; done
case " \$* " in
  *api.github.com*tags*) printf '%s\n' '[{"name":"v9.9.9"}]' ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/curl"; rm -f "$TMP/fetch.log"
env HOME="$TMP/home" KB_MENUBAR_ENV="$ENVF" PATH="$TMP/bin:/usr/bin:/bin" "$HERE/update.sh" >/dev/null 2>&1 || true
check "update.sh falls back to main when no swiftbar/v* tag exists" "grep -q '/main/plugins/swiftbar/' \"$TMP/fetch.log\""

# Explicit tag argument wins over tag-API resolution.
cat > "$TMP/bin/curl" <<STUB
#!/bin/sh
for a in "\$@"; do case "\$a" in https://raw.githubusercontent.com/*) echo "\$a" >> "$TMP/fetch.log" ;; esac; done
case " \$* " in
  *api.github.com*tags*) printf '%s\n' '[{"name":"swiftbar/v9.9.9"}]' ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/curl"; rm -f "$TMP/fetch.log"
env HOME="$TMP/home" KB_MENUBAR_ENV="$ENVF" PATH="$TMP/bin:/usr/bin:/bin" "$HERE/update.sh" v1.2.3 >/dev/null 2>&1 || true
check "update.sh honors explicit tag argument over tag API" "grep -q '/v1.2.3/plugins/swiftbar/' \"$TMP/fetch.log\" && ! grep -q '/swiftbar/v9.9.9/' \"$TMP/fetch.log\""
rm -f "$TMP/bin/curl"

echo "== indexing indicator =="
# Pre-seed the update-check throttle so these runs never touch the network.
mkdir -p "$TMP/home/.config/kb"; date +%s > "$TMP/home/.config/kb/.update-check"
FAKE_INDEX="$TMP/faiss"; mkdir -p "$FAKE_INDEX"
printf '%s\n' "KB_FAISS_INDEX_PATH=$FAKE_INDEX" >> "$ENVF"

out=$(env -i HOME="$TMP/home" PATH="/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF" "$TMP/fakerepo/plugins/swiftbar/kb-mcp.10s.sh" 2>/dev/null)
check "no signals -> index idle" "echo \"\$out\" | grep -q 'index: idle'"

# Live run marker ($$ = this test shell, provably alive while the plugin runs).
printf '{"schema_version":"reindex-run.v1","pid":%s,"started_at":"2026-11-12T00:00:00Z","kbs_in_scope":["kb1"],"hostname":"%s"}\n' "$$" "$(hostname)" \
  > "$FAKE_INDEX/.reindex.run.json"
out=$(env -i HOME="$TMP/home" PATH="/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF" "$TMP/fakerepo/plugins/swiftbar/kb-mcp.10s.sh" 2>/dev/null)
check "live run marker -> reindex IN PROGRESS" "echo \"\$out\" | grep -q 'reindex: IN PROGRESS'"
check "live run marker -> amber half-circle menubar" "echo \"\$out\" | head -1 | grep -q 'KB ◐'"

# Dead-pid marker must not report IN PROGRESS (zombie reclaim mirrors the
# server's checkReindexRunState). `sh -c 'echo $$'` returns its own pid —
# already dead when the substitution returns, with no `&`/`kill` race (a
# SIGTERM'd background subshell can run the inherited EXIT trap and nuke $TMP).
DEAD="$(sh -c 'echo $$')"
printf '{"schema_version":"reindex-run.v1","pid":%s,"started_at":"2026-11-12T00:00:00Z","kbs_in_scope":[]}\n' "$DEAD" \
  > "$FAKE_INDEX/.reindex.run.json"
out=$(env -i HOME="$TMP/home" PATH="/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF" "$TMP/fakerepo/plugins/swiftbar/kb-mcp.10s.sh" 2>/dev/null)
check "dead-pid run marker -> idle" "echo \"\$out\" | grep -q 'index: idle'"
rm -f "$FAKE_INDEX/.reindex.run.json"

# Fresh write lock + owner metadata -> "indexing: <command>".
mkdir -p "$FAKE_INDEX/models/m/.kb-write.lock"
printf '{"schema_version":"kb.write-lock-owner.v1","pid":%s,"command":"node /repo/build/cli.js reindex --with-context","hostname":"%s","started_at":"2026-11-12T00:00:00Z"}\n' "$$" "$(hostname)" \
  > "$FAKE_INDEX/models/m/.kb-write.lock.owner.json"
out=$(env -i HOME="$TMP/home" PATH="/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF" "$TMP/fakerepo/plugins/swiftbar/kb-mcp.10s.sh" 2>/dev/null)
check "fresh write lock -> indexing line" "echo \"\$out\" | grep -q 'indexing:'"
check "owner command surfaced in indexing line" "echo \"\$out\" | grep -q 'cli.js reindex'"

# Lock remnant older than the proper-lockfile stale bound (mtime >15s) -> idle.
touch -t 202001010000 "$FAKE_INDEX/models/m/.kb-write.lock"
out=$(env -i HOME="$TMP/home" PATH="/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF" "$TMP/fakerepo/plugins/swiftbar/kb-mcp.10s.sh" 2>/dev/null)
check "stale lock remnant -> idle" "echo \"\$out\" | grep -q 'index: idle'"

check "Reindex status menu action present" "echo \"\$out\" | grep -q 'Reindex status' && echo \"\$out\" | grep -q 'kb-mcp-reindex-status.sh'"
check "reindex-status helper syntax valid" "bash -n \"$HERE/kb-mcp-reindex-status.sh\""

echo "== round-trip on live setup =="
env KB_MENUBAR_ENV="$HOME/.config/kb/menubar.env.test" "$HERE/install.sh" >/dev/null 2>&1 \
  && check "real install works (test env file)" true || check "real install works (test env file)" false
rm -f "$HOME/.config/kb/menubar.env.test"

echo
echo "$PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
