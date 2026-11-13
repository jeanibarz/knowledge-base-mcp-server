#!/usr/bin/env bash
# Self-contained test harness for plugins/swiftbar/{install,uninstall}.sh
# Uses only temp dirs + env overrides — never touches the real SwiftBar
# plugin dir, menubar.env, or the live launchd service.
# KB_SKIP_LIVE=1 skips the checks that DO need the live launchd service +
# healthy /health endpoint (CI runners have neither).
# shellcheck disable=SC2015,SC2034  # `run && check || check` is intentional;
                                    # $out is consumed inside eval'd checks.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d /tmp/kb-swiftbar-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
PASS=0; FAIL=0; SKIP=0

ok()   { PASS=$((PASS+1)); echo "  ok   $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
skip() { SKIP=$((SKIP+1)); echo "  skip $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# KB_SKIP_LIVE=1 skips every check that needs the live launchd service +
# healthy /health endpoint — for CI runners that have neither.
LIVE=1; [[ "${KB_SKIP_LIVE:-}" == "1" ]] && LIVE=0

FAKE_APP="$TMP/SwiftBar.app";            mkdir -p "$FAKE_APP"
DST="$TMP/swiftbar-plugins"
ENVF="$TMP/menubar.env"
LABEL_OK="ai.knowledge-base.mcp"
LABEL_BAD="ai.kb.does-not-exist"

run() { env PATH="$TMP/bin:$PATH" "$@" "$HERE/install.sh" 2>&1; }

# install.sh calls `defaults write com.ameba.SwiftBar PluginsDirectory` — the
# REAL user domain. Shadow it so test installs can't repoint the live
# SwiftBar plugin dir at a temp dir that gets rm -rf'd on exit.
mkdir -p "$TMP/bin"
printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/defaults"; chmod +x "$TMP/bin/defaults"

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

if [[ $LIVE -eq 1 ]]; then
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
else
skip "happy path (real service) — 9 checks need the live launchd service"
fi

if [[ $LIVE -eq 1 ]]; then
echo "== idempotent reinstall =="
run KB_MCP_LABEL="$LABEL_OK" KB_SWIFTBAR_APP="$FAKE_APP" KB_PLUGIN_DST="$DST" KB_MENUBAR_ENV="$ENVF" >/dev/null 2>&1 \
  && check "second install exit 0" true || check "second install exit 0" false
else
skip "idempotent reinstall — needs the live launchd service"
fi

echo "== uninstall =="
env KB_PLUGIN_DST="$DST" KB_MENUBAR_ENV="$ENVF" "$HERE/uninstall.sh" >/dev/null 2>&1 \
  && check "uninstall exit 0" true || check "uninstall exit 0" false
check "plugin files removed" "[[ ! -f \"$DST/kb-mcp.10s.sh\" && ! -d \"$DST/helpers\" && \"\$(find \"$DST\" -type f -perm +111 | wc -l | tr -d ' ')\" == 0 ]]"
check "menubar.env removed" "[[ ! -f \"$ENVF\" ]]"
if [[ $LIVE -eq 1 ]]; then
  check "service untouched (still running)" "launchctl print gui/$(id -u)/$LABEL_OK 2>/dev/null | grep -q 'state = running'"
else
  skip "service untouched (still running) — needs the live launchd service"
fi
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

# Offline must be simulated by a failing curl stub — deleting the stub lets
# the plugin hit the REAL GitHub API, which shows a genuine update banner
# whenever a newer swiftbar/v* tag exists upstream.
cat > "$TMP/bin/curl" <<'STUB'
#!/bin/sh
exit 1
STUB
chmod +x "$TMP/bin/curl"; rm -f "$TMP/home/.config/kb/.update-check"*
out=$(env -i HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF" "$TMP/fakerepo/plugins/swiftbar/kb-mcp.10s.sh" 2>/dev/null)
check "offline -> silent, still renders KB line" "echo \"\$out\" | head -1 | grep -q '^KB' && ! echo \"\$out\" | grep -q 'Update available'"

# Regression guard for the whole offline class: assert the stubbed PATH has
# no working curl at all. If a stub is ever deleted again, or a run's PATH
# stops including $TMP/bin, real curl reaches the real GitHub API and this
# fails immediately instead of a downstream check flapping on real tags.
check "stubbed PATH really is offline" \
  "! env -i PATH=\"$TMP/bin:/usr/bin:/bin\" curl -fsS -m 3 https://api.github.com >/dev/null 2>&1"

echo "== update.sh sanity =="
# Use the fail-stub too: PATH=/usr/bin:/bin would make a REAL GitHub request
# whose result depends on the network, not on update.sh's error handling.
check "update.sh fetch failure exits nonzero" "! env HOME=\"$TMP/home\" KB_MENUBAR_ENV=\"$ENVF\" PATH=\"$TMP/bin:/usr/bin:/bin\" \"$HERE/update.sh\" bogus-tag 2>/dev/null"
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

echo "== file list follows the target tag (issue #1242) =="
# Stub curl: the tag's update.sh is served from $TMP/tag-update.sh (each case
# writes its own FILES line); every other file is served as a stub script, and
# VERSION as 1.0.0. Every raw-content URL is logged. The update installs into
# a scratch repo whose install.sh is the served stub, so a run can finish.
UPD_ENV="$TMP/upd.env"; printf '%s\n' "KB_MCP_REPO=$TMP/updrepo" > "$UPD_ENV"
cat > "$TMP/bin/curl" <<STUB
#!/bin/sh
url=""; out=""; prev=""
for a in "\$@"; do
  case "\$a" in https://raw.githubusercontent.com/*) url="\$a"; echo "\$a" >> "$TMP/fetch.log" ;; esac
  [ "\$prev" = "-o" ] && out="\$a"; prev="\$a"
done
case "\$url" in
  */update.sh) cp "$TMP/tag-update.sh" "\$out" ;;
  */VERSION) printf '1.0.0\n' > "\$out" ;;
  */kb-mcp-reindex-status.sh) exit 22 ;;  # absent at the old tag
  *) printf '#!/bin/sh\nexit 0\n' > "\$out" ;;
esac
STUB
chmod +x "$TMP/bin/curl"
run_update() { env HOME="$TMP/home" KB_MENUBAR_ENV="$UPD_ENV" PATH="$TMP/bin:/usr/bin:/bin" "$HERE/update.sh" swiftbar/v1.0.0 >/dev/null 2>&1; }

# The v1.0.0 file list, which predates kb-mcp-reindex-status.sh.
printf '%s\n' '#!/usr/bin/env bash' 'FILES="kb-mcp.10s.sh kb-mcp-rebuild.sh kb-mcp-uninstall.sh install.sh uninstall.sh update.sh VERSION"' > "$TMP/tag-update.sh"
rm -rf "$TMP/updrepo" "$TMP/fetch.log"
run_update && check "older tag -> update.sh succeeds" true || check "older tag -> update.sh succeeds" false
check "older tag -> file it never had is not requested" "! grep -q 'kb-mcp-reindex-status.sh' \"$TMP/fetch.log\""
check "older tag -> its files are installed" "[[ \$(cat \"$TMP/updrepo/plugins/swiftbar/VERSION\" 2>/dev/null) == 1.0.0 ]] && [[ -f \"$TMP/updrepo/plugins/swiftbar/kb-mcp-rebuild.sh\" ]]"

# A name that would escape the plugin dir aborts before anything is installed.
printf '%s\n' 'FILES="../evil VERSION update.sh"' > "$TMP/tag-update.sh"
rm -rf "$TMP/updrepo" "$TMP/fetch.log"
run_update && check "unsafe file name -> update.sh exits nonzero" false || check "unsafe file name -> update.sh exits nonzero" true
check "unsafe file name -> nothing installed" "[[ ! -e \"$TMP/updrepo\" ]] && ! grep -q 'evil' \"$TMP/fetch.log\""

# No parseable FILES line at the tag -> fall back to this script's own list
# (which includes the helper the stub refuses to serve -> fetch fails).
printf '%s\n' '#!/usr/bin/env bash' 'echo no list here' > "$TMP/tag-update.sh"
rm -rf "$TMP/updrepo" "$TMP/fetch.log"
run_update || true
check "no FILES line at tag -> falls back to local list" "grep -q 'kb-mcp-reindex-status.sh' \"$TMP/fetch.log\""

# The real v1.0.0 updater upgrading to this tree. It copies the new update.sh
# over itself mid-run, and bash then keeps reading the NEW file from the old
# byte offset. Editing update.sh can move that offset onto a line that breaks
# the upgrade, so pin that it still completes and installs the helper the old
# list lacks. Stub curl serves this tree's files (install.sh as a no-op stub).
if OLD_UPD="$(git -C "$HERE" show swiftbar/v1.0.0:plugins/swiftbar/update.sh 2>/dev/null)"; then
  cat > "$TMP/bin/curl" <<STUB
#!/bin/sh
url=""; out=""; prev=""
for a in "\$@"; do
  case "\$a" in https://raw.githubusercontent.com/*) url="\$a" ;; esac
  [ "\$prev" = "-o" ] && out="\$a"; prev="\$a"
done
f="\${url##*/}"
case "\$f" in
  "") exit 22 ;;
  install.sh) printf '#!/bin/sh\nexit 0\n' > "\$out" ;;
  *) cp "$HERE/\$f" "\$out" ;;
esac
STUB
  chmod +x "$TMP/bin/curl"
  rm -rf "$TMP/updrepo"; mkdir -p "$TMP/updrepo/plugins/swiftbar"
  printf '%s\n' "$OLD_UPD" > "$TMP/updrepo/plugins/swiftbar/update.sh"
  env HOME="$TMP/home" KB_MENUBAR_ENV="$UPD_ENV" PATH="$TMP/bin:/usr/bin:/bin" \
    bash "$TMP/updrepo/plugins/swiftbar/update.sh" swiftbar/v9.9.9 >/dev/null 2>&1 \
    && check "v1.0.0 updater -> upgrade to this tree exits 0" true \
    || check "v1.0.0 updater -> upgrade to this tree exits 0" false
  check "v1.0.0 updater -> new VERSION installed" "cmp -s \"$HERE/VERSION\" \"$TMP/updrepo/plugins/swiftbar/VERSION\""
  check "v1.0.0 updater -> helper missing from its list still installed" "[[ -f \"$TMP/updrepo/plugins/swiftbar/kb-mcp-reindex-status.sh\" ]]"
else
  skip "v1.0.0 updater upgrade check (tag swiftbar/v1.0.0 not in local clone)"
fi
rm -f "$TMP/bin/curl"

echo "== indexing indicator =="
# Pre-seed the update-check throttle so these runs never touch the network.
mkdir -p "$TMP/home/.config/kb"; date +%s > "$TMP/home/.config/kb/.update-check"
FAKE_INDEX="$TMP/faiss"; mkdir -p "$FAKE_INDEX"
printf '%s\n' "KB_FAISS_INDEX_PATH=$FAKE_INDEX" >> "$ENVF"

out=$(env -i HOME="$TMP/home" PATH="/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF" "$TMP/fakerepo/plugins/swiftbar/kb-mcp.10s.sh" 2>/dev/null)
check "no signals -> index idle" "echo \"\$out\" | grep -q 'index: idle'"
# fakerepo has no kb-mcp-reindex-status.sh — the state a v1.0 updater leaves
# behind after pulling 1.1 (issue #1242): offer a repair, not a dead action.
check "missing status helper -> repair action runs update.sh" \
  "echo \"\$out\" | grep -q 'Reindex status… (helper missing — repair) | bash=.*/update.sh'"
touch "$TMP/fakerepo/plugins/swiftbar/kb-mcp-reindex-status.sh"
out=$(env -i HOME="$TMP/home" PATH="/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF" "$TMP/fakerepo/plugins/swiftbar/kb-mcp.10s.sh" 2>/dev/null)
check "status helper present -> normal Reindex status action" \
  "echo \"\$out\" | grep -q 'Reindex status… | bash=.*/kb-mcp-reindex-status.sh'"

# Live run marker ($$ = this test shell, provably alive while the plugin runs).
printf '{"schema_version":"reindex-run.v1","pid":%s,"started_at":"2026-11-12T00:00:00Z","kbs_in_scope":["kb1"],"hostname":"%s"}\n' "$$" "$(hostname)" \
  > "$FAKE_INDEX/.reindex.run.json"
out=$(env -i HOME="$TMP/home" PATH="/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF" "$TMP/fakerepo/plugins/swiftbar/kb-mcp.10s.sh" 2>/dev/null)
check "live run marker -> reindex IN PROGRESS" "echo \"\$out\" | grep -q 'reindex: IN PROGRESS'"
if [[ $LIVE -eq 1 ]]; then
  check "live run marker -> amber half-circle menubar" "echo \"\$out\" | head -1 | grep -q 'KB ◐'"
else
  skip "live run marker -> amber half-circle menubar — needs live service health"
fi

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

# Injection: an owner command carrying a SwiftBar param fragment must not
# render an actionable row — the plugin truncates at the first '|'.
printf '{"schema_version":"kb.write-lock-owner.v1","pid":%s,"command":"node /repo/build/cli.js ask x | bash=/x","hostname":"%s","started_at":"2026-11-12T00:00:00Z"}\n' "$$" "$(hostname)" \
  > "$FAKE_INDEX/models/m/.kb-write.lock.owner.json"
out=$(env -i HOME="$TMP/home" PATH="/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF" "$TMP/fakerepo/plugins/swiftbar/kb-mcp.10s.sh" 2>/dev/null)
check "pipe-injection owner command -> no bash= param" "echo \"\$out\" | grep 'indexing:' | grep -qv 'bash='"
check "pipe-injection owner command -> truncated content" "echo \"\$out\" | grep -q 'indexing: /repo/build/cli.js ask x'"

# Lock remnant older than the proper-lockfile stale bound (mtime >15s) -> idle.
touch -t 202001010000 "$FAKE_INDEX/models/m/.kb-write.lock"
out=$(env -i HOME="$TMP/home" PATH="/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF" "$TMP/fakerepo/plugins/swiftbar/kb-mcp.10s.sh" 2>/dev/null)
check "stale lock remnant -> idle" "echo \"\$out\" | grep -q 'index: idle'"

check "Reindex status menu action present" "echo \"\$out\" | grep -q 'Reindex status' && echo \"\$out\" | grep -q 'kb-mcp-reindex-status.sh'"
check "reindex-status helper syntax valid" "bash -n \"$HERE/kb-mcp-reindex-status.sh\""

if [[ $LIVE -eq 1 ]]; then
echo "== round-trip on live setup =="
env KB_MENUBAR_ENV="$HOME/.config/kb/menubar.env.test" "$HERE/install.sh" >/dev/null 2>&1 \
  && check "real install works (test env file)" true || check "real install works (test env file)" false
rm -f "$HOME/.config/kb/menubar.env.test"
else
skip "round-trip on live setup — needs the live launchd service"
fi

echo
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[[ $FAIL -eq 0 ]]
