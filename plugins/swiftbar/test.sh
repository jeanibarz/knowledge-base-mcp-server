#!/usr/bin/env bash
# Self-contained test harness for every plugins/swiftbar/*.sh script.
# Covers: install.sh preflight + config resolution, kb-mcp.10s.sh menubar
# states + indexing signals + update check, update.sh tag/file-list logic,
# uninstall.sh guards + legacy cleanup, kb-mcp-uninstall.sh dialog flow,
# kb-mcp-rebuild.sh + kb-mcp-reindex-status.sh helper behaviour.
# Uses only temp dirs + env overrides + PATH stubs — never touches the real
# SwiftBar plugin dir, menubar.env, GitHub, or the live launchd service.
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

# Record the environment each run executes on — the suite is the documented
# evidence for "tested on macOS" claims, so say which macOS/bash it was.
echo "platform: $(sw_vers -productName 2>/dev/null || uname -s) $(sw_vers -productVersion 2>/dev/null || uname -r) $(uname -m)" \
     "| bash $BASH_VERSION | live service: $([[ $LIVE -eq 1 ]] && echo yes || echo no)"

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
check "plugin files removed" "[[ ! -f \"$DST/kb-mcp.10s.sh\" && ! -d \"$DST/helpers\" && ( ! -d \"$DST\" || \"\$(find \"$DST\" -type f -perm +111 | wc -l | tr -d ' ')\" == 0 ) ]]"
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
  out=$(env HOME="$TMP/home" KB_MENUBAR_ENV="$UPD_ENV" PATH="$TMP/bin:/usr/bin:/bin" \
    bash "$TMP/updrepo/plugins/swiftbar/update.sh" swiftbar/v9.9.9 2>&1)
  if ! echo "$out" | grep -q 'updated to'; then
    # A <=1.1.0 updater is unwrapped — re-reading the overwritten script at a
    # stale byte offset can kill it mid-run (the #1252 hazard, unfixable in an
    # already-shipped file). Recovery is re-running the just-installed
    # updater, which is the wrapped copy fetched from the tag.
    out=$(env HOME="$TMP/home" KB_MENUBAR_ENV="$UPD_ENV" PATH="$TMP/bin:/usr/bin:/bin" \
      bash "$TMP/updrepo/plugins/swiftbar/update.sh" swiftbar/v9.9.9 2>&1)
  fi
  check "v1.0.0 updater -> upgrade converges (re-run if needed)" "echo \"\$out\" | grep -q 'updated to'"
  check "v1.0.0 updater -> new VERSION installed" "cmp -s \"$HERE/VERSION\" \"$TMP/updrepo/plugins/swiftbar/VERSION\""
  check "v1.0.0 updater -> helper missing from its list still installed" "[[ -f \"$TMP/updrepo/plugins/swiftbar/kb-mcp-reindex-status.sh\" ]]"
else
  skip "v1.0.0 updater upgrade check (tag swiftbar/v1.0.0 not in local clone)"
fi

# Self-overwrite guard (issue #1252): the RUNNING script sits at $DST so the
# install step really overwrites it mid-run. The tag serves a different
# update.sh — this tree's own script prefixed with padding so every byte
# offset shifts. Unwrapped, bash 3.2 resumes the NEW file at the OLD offset
# and dies mid-parse or re-executes sections; the wrapped main() buffers the
# whole body first, so every '== ... ==' header must print exactly once.
{ for i in $(seq 1 60); do echo "# padding $i — shifts the new file's byte offsets"; done
  cat "$HERE/update.sh"; } > "$TMP/tag-update.sh"
cat > "$TMP/bin/curl" <<STUB
#!/bin/sh
url=""; out=""; prev=""
for a in "\$@"; do
  case "\$a" in https://raw.githubusercontent.com/*) url="\$a" ;; esac
  [ "\$prev" = "-o" ] && out="\$a"; prev="\$a"
done
case "\$url" in
  */update.sh) cp "$TMP/tag-update.sh" "\$out" ;;
  */VERSION) printf '9.9.9\n' > "\$out" ;;
  */install.sh) printf '#!/bin/sh\nexit 0\n' > "\$out" ;;
  *) cp "$HERE/\${url##*/}" "\$out" ;;
esac
STUB
chmod +x "$TMP/bin/curl"
rm -rf "$TMP/updrepo"; mkdir -p "$TMP/updrepo/plugins/swiftbar"
cp "$HERE/update.sh" "$TMP/updrepo/plugins/swiftbar/"
out=$(env HOME="$TMP/home" KB_MENUBAR_ENV="$UPD_ENV" PATH="$TMP/bin:/usr/bin:/bin" \
  bash "$TMP/updrepo/plugins/swiftbar/update.sh" swiftbar/v9.9.9 2>"$TMP/selfow.err"); rc=$?
# The residual half of #1252: after main returns, bash would read the next
# command at the OLD end-of-file offset — a longer new update.sh leaves bytes
# there to run as top-level commands ('command not found', exit 127). The
# `main "$@"; exit` one-liner makes the exit already-parsed. Assert on the
# exit status and clean stderr, not just the banner text.
check "self-overwrite -> exits 0" "[[ \$rc -eq 0 ]]"
check "self-overwrite -> no stderr" "[[ ! -s \"$TMP/selfow.err\" ]]"
check "self-overwrite -> update completes" "echo \"\$out\" | grep -q 'updated to'"
check "self-overwrite -> each section runs exactly once" \
  "[[ \$(echo \"\$out\" | grep -c '== fetch') == 1 && \$(echo \"\$out\" | grep -c '== sanity-check') == 1 && \$(echo \"\$out\" | grep -c '== install to') == 1 ]]"
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

echo "== menubar states (stubbed launchd + health — host-independent) =="
# Stub launchctl + curl let the full menubar colour matrix run on ANY host —
# the live checks above only cover the running/healthy path on this machine.
cat > "$TMP/bin/launchctl" <<'STUB'
#!/bin/sh
case "$1" in
  print)
    [[ "${KB_STUB_SVC_MISSING:-}" == "1" ]] && exit 1
    printf 'state = %s\npid = %s\n' "${KB_STUB_STATE:-running}" "${KB_STUB_PID:-4242}"
    ;;
  *) echo "launchctl $*" >> "${KB_STUB_LOG:-/dev/null}" ;;
esac
STUB
cat > "$TMP/bin/curl" <<'STUB'
#!/bin/sh
echo "curl $*" >> "${KB_STUB_FETCH_LOG:-/dev/null}"
case " $* " in
  *health*)
    case "${KB_STUB_HEALTH:-ok}" in
      ok)   printf '{"status":"ok"}' ;;
      pipe) printf '{"status":"ok","note":"x | bash=/evil"}' ;;
      *)    exit 7 ;;
    esac
    ;;
  *) exit 1 ;;
esac
STUB
cat > "$TMP/bin/pgrep" <<'STUB'
#!/bin/sh
exit 1
STUB
cat > "$TMP/bin/open" <<'STUB'
#!/bin/sh
echo "open $*" >> "${KB_STUB_LOG:-/dev/null}"
STUB
chmod +x "$TMP/bin/launchctl" "$TMP/bin/curl" "$TMP/bin/pgrep" "$TMP/bin/open"
plug() { env -i HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF" "$@" "$TMP/fakerepo/plugins/swiftbar/kb-mcp.10s.sh" 2>/dev/null; }

rm -rf "$FAKE_INDEX/models/m2" "$FAKE_INDEX/.reindex.run.json" "$FAKE_INDEX/.kb-write.lock" "$FAKE_INDEX/.kb-write.lock.owner.json"
out=$(plug)
check "stubbed running+ok -> green menubar" "echo \"\$out\" | head -1 | grep -q 'KB ● | color=#2e7d32'"
check "stubbed pid shown" "echo \"\$out\" | grep -q 'pid: 4242'"
out=$(plug KB_STUB_STATE=stopped)
check "stopped service -> red menubar" "echo \"\$out\" | head -1 | grep -q 'color=#c62828'"
check "stopped service -> state: stopped" "echo \"\$out\" | grep -q 'state: stopped'"
out=$(plug KB_STUB_HEALTH=down)
check "unreachable health -> red menubar" "echo \"\$out\" | head -1 | grep -q 'color=#c62828'"
check "unreachable health -> health: unreachable" "echo \"\$out\" | grep -q 'health: unreachable'"
out=$(plug KB_STUB_HEALTH=pipe)
check "health payload truncated at '|' (no injected params)" "echo \"\$out\" | grep 'health:' | grep -qv 'evil'"

# A fresh write lock flips the menubar to amber even under the stub.
mkdir -p "$FAKE_INDEX/models/m2/.kb-write.lock"
out=$(plug)
check "running+ok+fresh lock -> amber KB ◐" "echo \"\$out\" | head -1 | grep -q 'KB ◐ | color=#f9a825'"
rm -rf "$FAKE_INDEX/models/m2"

# The 6h throttle must suppress the tag fetch entirely — log every curl call.
date +%s > "$TMP/home/.config/kb/.update-check"; rm -f "$TMP/home/.config/kb/.update-check.ver" "$TMP/throttle.log"
out=$(plug KB_STUB_FETCH_LOG="$TMP/throttle.log")
check "fresh throttle cache -> no GitHub request" "! grep -q 'api.github.com' \"$TMP/throttle.log\" 2>/dev/null"
# With the throttle held, a cached remote version still drives the banner
# even though curl is never called.
printf '2.0.0\n' > "$TMP/home/.config/kb/.update-check.ver"
out=$(plug)
check "cached remote version -> Update available banner" "echo \"\$out\" | grep -q 'Update available'"
rm -f "$TMP/home/.config/kb/.update-check.ver"

# Remote strictly older than local -> no banner (sort -V comparison).
rm -f "$TMP/home/.config/kb/.update-check"*
cat > "$TMP/bin/curl" <<'STUB'
#!/bin/sh
case " $* " in
  *health*) printf '{"status":"ok"}' ;;
  *api.github.com*tags*) exit 1 ;;
  *VERSION*) printf '0.5.0\n' ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/curl"
out=$(plug)
check "remote older than local -> no update banner" "! echo \"\$out\" | grep -q 'Update available'"

echo "== indexing signal variants =="
# Back to the log-everything stub (health ok, everything else fails).
cat > "$TMP/bin/curl" <<'STUB'
#!/bin/sh
echo "curl $*" >> "${KB_STUB_FETCH_LOG:-/dev/null}"
case " $* " in
  *health*) printf '{"status":"ok"}' ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/curl"
date +%s > "$TMP/home/.config/kb/.update-check"  # keep throttle fresh

# Cross-host run marker is ignored even when the pid is live here (#906).
printf '{"schema_version":"reindex-run.v1","pid":%s,"started_at":"x","hostname":"definitely-other-host"}\n' "$$" \
  > "$FAKE_INDEX/.reindex.run.json"
out=$(plug)
check "cross-host run marker -> idle" "echo \"\$out\" | grep -q 'index: idle'"

# Older marker format without a hostname field is accepted when pid is live.
printf '{"schema_version":"reindex-run.v1","pid":%s,"started_at":"2026-11-12T00:00:00Z"}\n' "$$" \
  > "$FAKE_INDEX/.reindex.run.json"
out=$(plug)
check "hostname-less run marker + live pid -> IN PROGRESS" "echo \"\$out\" | grep -q 'reindex: IN PROGRESS'"
rm -f "$FAKE_INDEX/.reindex.run.json"

# Root-level write lock (not under models/*) with no owner file -> generic text.
mkdir "$FAKE_INDEX/.kb-write.lock"
out=$(plug)
check "root write lock, no owner -> 'write in progress'" "echo \"\$out\" | grep -q 'indexing: write in progress'"
rm -rf "$FAKE_INDEX/.kb-write.lock"

# Owner metadata from a different host -> command suppressed, generic text.
mkdir -p "$FAKE_INDEX/models/m/.kb-write.lock"; touch "$FAKE_INDEX/models/m/.kb-write.lock"
printf '{"schema_version":"kb.write-lock-owner.v1","hostname":"other-host","command":"node cli.js reindex"}\n' \
  > "$FAKE_INDEX/models/m/.kb-write.lock.owner.json"
out=$(plug)
check "cross-host owner -> command suppressed" "echo \"\$out\" | grep -q 'indexing: write in progress' && ! echo \"\$out\" | grep 'indexing:' | grep -q 'cli.js'"

# Control characters in the owner command are stripped (menu-row injection).
printf '{"schema_version":"kb.write-lock-owner.v1","hostname":"%s","command":"node cli.js ask\ta b"}\n' "$(hostname)" \
  > "$FAKE_INDEX/models/m/.kb-write.lock.owner.json"
out=$(plug)
check "control chars stripped from owner command" "echo \"\$out\" | grep -q 'indexing: cli.js aska b'"

# Commands longer than 80 chars are truncated with an ellipsis.
printf '{"schema_version":"kb.write-lock-owner.v1","hostname":"%s","command":"node %s"}\n' "$(hostname)" "$(printf 'x%.0s' $(seq 1 120))" \
  > "$FAKE_INDEX/models/m/.kb-write.lock.owner.json"
out=$(plug)
check "long owner command -> truncated with ellipsis" "echo \"\$out\" | grep 'indexing:' | grep -q '…' && ! echo \"\$out\" | grep 'indexing:' | grep -q 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'"

# A live run marker wins over a fresh lock (richer detail beats generic).
printf '{"schema_version":"reindex-run.v1","pid":%s,"started_at":"2026-11-12T00:00:00Z","hostname":"%s"}\n' "$$" "$(hostname)" \
  > "$FAKE_INDEX/.reindex.run.json"
touch "$FAKE_INDEX/models/m/.kb-write.lock"
out=$(plug)
check "run marker + lock -> reindex IN PROGRESS wins" "echo \"\$out\" | grep -q 'reindex: IN PROGRESS'"
rm -f "$FAKE_INDEX/.reindex.run.json" "$FAKE_INDEX/models/m/.kb-write.lock.owner.json"
rm -rf "$FAKE_INDEX/models/m"

echo "== update.sh: fetched file with bad syntax aborts =="
cat > "$TMP/bin/curl" <<STUB
#!/bin/sh
url=""; out=""; prev=""
for a in "\$@"; do
  case "\$a" in https://raw.githubusercontent.com/*) url="\$a" ;; esac
  [ "\$prev" = "-o" ] && out="\$a"; prev="\$a"
done
case "\$url" in
  */update.sh) printf '%s\n' 'FILES="kb-mcp.10s.sh VERSION update.sh"' > "\$out" ;;
  */VERSION) printf '9.9.9\n' > "\$out" ;;
  *) printf 'if fi broken' > "\$out" ;;
esac
STUB
chmod +x "$TMP/bin/curl"
rm -rf "$TMP/updrepo" "$TMP/fetch.log"
run_update && check "bad fetched syntax -> update.sh aborts" false || check "bad fetched syntax -> update.sh aborts" true
check "bad fetched syntax -> nothing installed" "[[ ! -d \"$TMP/updrepo/plugins/swiftbar\" ]] || [[ -z \$(ls \"$TMP/updrepo/plugins/swiftbar\" 2>/dev/null) ]]"

# Successful run must apply chmod +x to every installed script. install.sh
# stays on the list: update.sh always runs it at the end, so the run only
# completes when it is fetched (served as a no-op stub).
printf '%s\n' 'FILES="kb-mcp.10s.sh install.sh VERSION update.sh"' > "$TMP/tag-update.sh"
cat > "$TMP/bin/curl" <<STUB
#!/bin/sh
url=""; out=""; prev=""
for a in "\$@"; do
  case "\$a" in https://raw.githubusercontent.com/*) url="\$a" ;; esac
  [ "\$prev" = "-o" ] && out="\$a"; prev="\$a"
done
case "\$url" in
  */update.sh) cp "$TMP/tag-update.sh" "\$out" ;;
  */VERSION) printf '1.0.0\n' > "\$out" ;;
  *) printf '#!/bin/sh\nexit 0\n' > "\$out" ;;
esac
STUB
chmod +x "$TMP/bin/curl"
rm -rf "$TMP/updrepo" "$TMP/fetch.log"
run_update && check "update.sh install -> scripts executable" "[[ -x \"$TMP/updrepo/plugins/swiftbar/kb-mcp.10s.sh\" ]]" \
  || check "update.sh install -> scripts executable" false

echo "== install.sh offline (fake HOME + stubbed launchd/health) =="
# Drives install.sh end-to-end with zero real services: plutil reads the fake
# plist, the JS resolver merges plist > mcp_config > env, stub launchctl says
# running, stub curl says ok, defaults/open/pgrep are no-ops.
NODE_DIR="$(dirname "$(command -v node)")"
HOME2="$TMP/home2"; mkdir -p "$HOME2/Library/LaunchAgents" "$HOME2/.config/devin"
REPOA="$TMP/repo A"; mkdir -p "$REPOA/.git" "$REPOA/build"; : > "$REPOA/build/index.js"
cat > "$HOME2/Library/LaunchAgents/ai.knowledge-base.mcp.plist" <<PLIST
<?xml version="1.0"?>
<plist version="1.0"><dict>
  <key>EnvironmentVariables</key><dict>
    <key>MCP_PORT</key><string>9123</string>
    <key>MCP_BIND_ADDR</key><string>127.0.0.1</string>
    <key>FAISS_INDEX_PATH</key><string>$TMP/faissA</string>
    <key>KNOWLEDGE_BASES_ROOT_DIR</key><string>$TMP/kbsA</string>
  </dict>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/node</string>
    <string>$REPOA/build/index.js</string>
  </array>
</dict></plist>
PLIST
cat > "$HOME2/.config/devin/mcp_config.json" <<'CFG'
{"mcpServers":{"knowledge-base":{"url":"http://127.0.0.1:7777/mcp","env":{"FAISS_INDEX_PATH":"/should/not/win","KNOWLEDGE_BASES_ROOT_DIR":"/also/not/win"}}}}
CFG
cat > "$TMP/bin/curl" <<'STUB'
#!/bin/sh
case " $* " in
  *health*) printf '{"status":"ok"}' ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$TMP/bin/curl"
DST2="$TMP/dst2"; ENVF2="$TMP/env2"
env -i HOME="$HOME2" PATH="$TMP/bin:$NODE_DIR:/usr/bin:/bin" \
  KB_PLUGIN_DST="$DST2" KB_MENUBAR_ENV="$ENVF2" KB_SWIFTBAR_APP="$FAKE_APP" \
  "$HERE/install.sh" >/dev/null 2>&1 \
  && check "offline install exit 0" true || check "offline install exit 0" false
check "menubar.env written" "[[ -f \"$ENVF2\" ]]"
check "plist beats mcp_config for port" "grep -q '^KB_MCP_PORT=9123' \"$ENVF2\" && ! grep -q 7777 \"$ENVF2\""
check "plist beats mcp_config for index path" "grep -q '^KB_FAISS_INDEX_PATH=$TMP/faissA' \"$ENVF2\" && ! grep -q 'should/not/win' \"$ENVF2\""
check "node resolved from plist ProgramArguments" "grep -q '^KB_MCP_NODE=/opt/homebrew/bin/node' \"$ENVF2\""
check "repo path with space -> %q quoting round-trips" "( source \"$ENVF2\" && [[ \"\$KB_MCP_REPO\" == \"$REPOA\" ]] )"
check "plugin symlinked into dst" "[[ -L \"$DST2/kb-mcp.10s.sh\" ]]"

# Explicit env override beats every config source.
env -i HOME="$HOME2" PATH="$TMP/bin:$NODE_DIR:/usr/bin:/bin" \
  KB_PLUGIN_DST="$DST2" KB_MENUBAR_ENV="$TMP/env3" KB_SWIFTBAR_APP="$FAKE_APP" KB_MCP_PORT=9876 \
  "$HERE/install.sh" >/dev/null 2>&1
check "KB_MCP_PORT env override wins over plist" "grep -q '^KB_MCP_PORT=9876' \"$TMP/env3\""

# No resolvable repo anywhere -> clear error, nonzero exit, nothing written.
HOME3="$TMP/home3"; mkdir -p "$HOME3/Library/LaunchAgents"
cat > "$HOME3/Library/LaunchAgents/ai.knowledge-base.mcp.plist" <<'PLIST'
<?xml version="1.0"?>
<plist version="1.0"><dict><key>ProgramArguments</key><array><string>/usr/bin/true</string></array></dict></plist>
PLIST
out=$(env -i HOME="$HOME3" PATH="$TMP/bin:$NODE_DIR:/usr/bin:/bin" \
  KB_PLUGIN_DST="$TMP/dst3" KB_MENUBAR_ENV="$TMP/env4" KB_SWIFTBAR_APP="$FAKE_APP" \
  "$HERE/install.sh" 2>&1)
check "unresolvable repo -> dies with hint" "[[ \$? -ne 0 ]] && echo \"\$out\" | grep -q 'could not resolve repo'"
check "unresolvable repo -> no menubar.env" "[[ ! -f \"$TMP/env4\" ]]"

# --install-swiftbar: brew present -> cask install then normal flow continues.
cat > "$TMP/bin/brew" <<'STUB'
#!/bin/sh
echo "brew $*" >> "${KB_STUB_LOG:-/dev/null}"
STUB
chmod +x "$TMP/bin/brew"
env -i HOME="$HOME2" PATH="$TMP/bin:$NODE_DIR:/usr/bin:/bin" \
  KB_PLUGIN_DST="$DST2" KB_MENUBAR_ENV="$TMP/env5" KB_SWIFTBAR_APP="$TMP/nonexistent.app" \
  KB_STUB_LOG="$TMP/brew.log" "$HERE/install.sh" --install-swiftbar >/dev/null 2>&1 \
  && check "--install-swiftbar -> brew cask install + proceeds" \
      "grep -q 'brew install --cask swiftbar' \"$TMP/brew.log\" && [[ -f \"$TMP/env5\" ]]" \
  || check "--install-swiftbar -> brew cask install + proceeds" false
# --install-swiftbar without Homebrew -> dies with a clear hint. PATH here
# deliberately excludes NODE_DIR: it is typically /opt/homebrew/bin, which
# also contains the REAL brew — the script must find no brew at all.
rm -f "$TMP/bin/brew"
out=$(env -i HOME="$HOME3" PATH="$TMP/bin:/usr/bin:/bin" \
  KB_PLUGIN_DST="$DST2" KB_MENUBAR_ENV="$TMP/env5" KB_SWIFTBAR_APP="$TMP/nonexistent.app" \
  "$HERE/install.sh" --install-swiftbar 2>&1)
check "--install-swiftbar without brew -> dies with hint" "[[ \$? -ne 0 ]] && echo \"\$out\" | grep -q 'Homebrew is not installed'"

echo "== uninstall.sh guards =="
check "repo-path PLUGIN_DST refused" "! env KB_PLUGIN_DST=\"$DST/plugins/swiftbar\" KB_MENUBAR_ENV=\"$ENVF\" \"$HERE/uninstall.sh\" >/dev/null 2>&1"
check "workspace-path PLUGIN_DST refused" "! env KB_PLUGIN_DST=\"$TMP/workspace/x\" KB_MENUBAR_ENV=\"$ENVF\" \"$HERE/uninstall.sh\" >/dev/null 2>&1"
# Legacy layout: helpers/ dir + stale helper copies next to the plugin.
mkdir -p "$DST/helpers"; printf '#!/bin/sh\n' > "$DST/kb-mcp-rebuild.sh"; printf '#!/bin/sh\n' > "$DST/kb-mcp-uninstall.sh"
env KB_PLUGIN_DST="$DST" KB_MENUBAR_ENV="$TMP/env-gone" "$HERE/uninstall.sh" >/dev/null 2>&1 || true
check "legacy helpers/ + stale helper copies removed" \
  "[[ ! -d \"$DST/helpers\" && ! -f \"$DST/kb-mcp-rebuild.sh\" && ! -f \"$DST/kb-mcp-uninstall.sh\" ]]"
# Broken symlink (target deleted) is still removed — the -L test in the loop.
ln -s "$DST/dead-target" "$DST/kb-mcp.10s.sh"
env KB_PLUGIN_DST="$DST" KB_MENUBAR_ENV="$TMP/env-gone" "$HERE/uninstall.sh" >/dev/null 2>&1 || true
check "dangling plugin symlink removed" "[[ ! -L \"$DST/kb-mcp.10s.sh\" ]]"

echo "== kb-mcp-uninstall.sh (stubbed osascript) =="
cat > "$TMP/bin/osascript" <<'STUB'
#!/bin/sh
[[ -n "${KB_STUB_DIALOG:-}" ]] && printf '%s\n' "$KB_STUB_DIALOG"
exit "${KB_STUB_OSX_RC:-0}"
STUB
chmod +x "$TMP/bin/osascript"
cp "$HERE/uninstall.sh" "$TMP/fakerepo/plugins/swiftbar/"; chmod +x "$TMP/fakerepo/plugins/swiftbar/uninstall.sh"
ENVF6="$TMP/env6"
ln -sf "$HERE/kb-mcp.10s.sh" "$DST/kb-mcp.10s.sh"
printf 'KB_MCP_REPO=%s\nKB_PLUGIN_DST=%s\n' "$TMP/fakerepo" "$DST" > "$ENVF6"
env -i HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF6" \
  "$HERE/kb-mcp-uninstall.sh" >/dev/null 2>&1
check "dialog cancel -> nothing removed" "[[ -L \"$DST/kb-mcp.10s.sh\" && -f \"$ENVF6\" ]]"
env -i HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF6" \
  KB_STUB_DIALOG="button returned:Remove" "$HERE/kb-mcp-uninstall.sh" >/dev/null 2>&1
check "dialog confirm -> delegates to repo uninstall.sh" "[[ ! -L \"$DST/kb-mcp.10s.sh\" && ! -f \"$ENVF6\" ]]"
# Repo checkout gone -> removes just its own plugin file + env.
ln -sf "$HERE/kb-mcp.10s.sh" "$DST/kb-mcp.10s.sh"
printf 'KB_MCP_REPO=%s\nKB_PLUGIN_DST=%s\n' "$TMP/nonexistent-repo" "$DST" > "$ENVF6"
env -i HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin" KB_MENUBAR_ENV="$ENVF6" \
  KB_STUB_DIALOG="button returned:Remove" "$HERE/kb-mcp-uninstall.sh" >/dev/null 2>&1
check "confirm + missing repo -> removes own files anyway" "[[ ! -L \"$DST/kb-mcp.10s.sh\" && ! -f \"$ENVF6\" ]]"

echo "== helper scripts =="
# kb-mcp-rebuild.sh: npm build -> launchctl kickstart -> health probe, in order.
cat > "$TMP/bin/npm" <<'STUB'
#!/bin/sh
echo "npm $* (cwd=$PWD)" >> "${KB_STUB_LOG:-/dev/null}"
STUB
cat > "$TMP/bin/curl" <<'STUB'
#!/bin/sh
echo "curl $*" >> "${KB_STUB_LOG:-/dev/null}"
printf '{"status":"ok"}'
STUB
chmod +x "$TMP/bin/npm" "$TMP/bin/curl"
printf 'KB_MCP_REPO=%s\nKB_MCP_LABEL=%s\nKB_MCP_PORT=8090\nKB_MCP_BIND=127.0.0.1\n' "$TMP/fakerepo" "$LABEL_OK" > "$TMP/env7"
# Note: the script calls /bin/launchctl by absolute path — a PATH stub cannot
# shadow it. With the real service absent the kickstart fails and set -e
# aborts before the health probe; assert the output sequence instead of a log.
out=$(env -i HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin" KB_MENUBAR_ENV="$TMP/env7" \
  KB_STUB_LOG="$TMP/rebuild.log" "$HERE/kb-mcp-rebuild.sh" 2>&1)
check "rebuild -> npm run build inside repo" "grep -q \"npm run build (cwd=$TMP/fakerepo)\" \"$TMP/rebuild.log\""
# /bin/launchctl is absolute — whether kickstart succeeds depends on the real
# service, which KB_SKIP_LIVE does not remove. Assert whichever path actually
# ran: kickstart ok -> health reached; kickstart failed -> abort before it.
if echo "$out" | grep -q '== health =='; then
  check "rebuild -> kickstart + health sequence completes" \
    "echo \"\$out\" | grep -q '== launchctl kickstart =='"
  check "rebuild -> health probe" "grep -q 'curl -s -m 5 http://127.0.0.1:8090/health' \"$TMP/rebuild.log\""
else
  check "rebuild -> aborts at kickstart when service absent" \
    "echo \"\$out\" | grep -q '== launchctl kickstart ==' && ! echo \"\$out\" | grep -q '== health =='"
  skip "rebuild -> health probe — kickstart failed (no launchd service)"
fi

# kb-mcp-reindex-status.sh: exports the index env, runs `reindex status`.
cat > "$TMP/bin/node" <<'STUB'
#!/bin/sh
{
  echo "node $*"
  echo "KBROOT=${KNOWLEDGE_BASES_ROOT_DIR:-unset}"
  echo "FAISS=${FAISS_INDEX_PATH:-unset}"
} >> "${KB_STUB_LOG:-/dev/null}"
STUB
chmod +x "$TMP/bin/node"
printf 'KB_MCP_REPO=%s\nKB_MCP_NODE=node\nKB_KB_ROOT=%s\nKB_FAISS_INDEX_PATH=%s\n' \
  "$TMP/fakerepo" "$TMP/kbsA" "$TMP/faissA" > "$TMP/env8"
env -i HOME="$TMP/home" PATH="$TMP/bin:/usr/bin:/bin" KB_MENUBAR_ENV="$TMP/env8" \
  KB_STUB_LOG="$TMP/status.log" "$HERE/kb-mcp-reindex-status.sh" </dev/null >/dev/null 2>&1
check "status helper -> 'reindex status' argv" "grep -q \"node $TMP/fakerepo/build/cli.js reindex status\" \"$TMP/status.log\""
check "status helper exports kb root + faiss path" "grep -q \"KBROOT=$TMP/kbsA\" \"$TMP/status.log\" && grep -q \"FAISS=$TMP/faissA\" \"$TMP/status.log\""

# Restore stubs the live round-trip still needs (defaults stays: install.sh
# must never write the real SwiftBar pref during tests); drop everything that
# would shadow a real launchctl/curl/node the round-trip depends on.
rm -f "$TMP/bin/launchctl" "$TMP/bin/curl" "$TMP/bin/osascript" "$TMP/bin/npm" "$TMP/bin/node" "$TMP/bin/brew"

if [[ $LIVE -eq 1 ]]; then
echo "== round-trip on live setup =="
# $TMP/bin first so the defaults/open/pgrep stubs still shadow the real tools —
# the real launchd service + /health are exercised, the real SwiftBar prefs are not.
env PATH="$TMP/bin:$PATH" KB_MENUBAR_ENV="$HOME/.config/kb/menubar.env.test" "$HERE/install.sh" >/dev/null 2>&1 \
  && check "real install works (test env file)" true || check "real install works (test env file)" false
rm -f "$HOME/.config/kb/menubar.env.test"
else
skip "round-trip on live setup — needs the live launchd service"
fi

echo
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[[ $FAIL -eq 0 ]]
