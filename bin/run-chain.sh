#!/usr/bin/env bash
# Run kb CLI evolution iterations back to back until STOP, max-iter, or a state cap.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SCRIPT_DIR/.." && pwd)
STOP_FLAG="$REPO/STOP"
HEARTBEAT="$REPO/.chain-heartbeat"

MAX_ITER=0
SLEEP_S=1
while [ $# -gt 0 ]; do
  case "$1" in
    --max-iter) MAX_ITER="$2"; shift 2 ;;
    --sleep) SLEEP_S="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 64 ;;
  esac
done

stopping=0
on_signal() { echo; echo "[chain] stop signal received; finishing cleanly."; stopping=1; }
trap on_signal INT TERM

cleanup() { rm -f "$HEARTBEAT"; }
trap cleanup EXIT

[ -f "$STOP_FLAG" ] && { echo "[chain] STOP flag present at $STOP_FLAG; remove it to run."; exit 0; }
echo "pid=$$ started=$(date -u +%FT%TZ)" > "$HEARTBEAT"
echo "[chain] starting (pid $$). sleep=${SLEEP_S}s max_iter=$([ "$MAX_ITER" -eq 0 ] && echo "unlimited" || echo "$MAX_ITER")."
echo "[chain] stop with: Ctrl-C | touch $STOP_FLAG | kill $$"

count=0
while :; do
  [ "$stopping" -eq 1 ] && { echo "[chain] stopped after $count iteration(s)."; break; }
  if [ -f "$STOP_FLAG" ]; then
    echo "[chain] STOP flag detected; stopping after $count iteration(s)."; break
  fi
  if [ "$MAX_ITER" -ne 0 ] && [ "$count" -ge "$MAX_ITER" ]; then
    echo "[chain] reached --max-iter $MAX_ITER; stopping."; break
  fi

  set +e
  "$REPO/bin/run-iteration.sh"
  rc=$?
  set -e
  count=$((count + 1))
  echo "iters_done=$count last_rc=$rc updated=$(date -u +%FT%TZ)" >> "$HEARTBEAT"

  case "$rc" in
    0) : ;;
    3) echo "[chain] no eligible candidates or state cap reached; chain complete."; break ;;
    *) echo "[chain] iteration error (rc=$rc); stopping for safety."; break ;;
  esac

  sleep "$SLEEP_S"
done
echo "[chain] done. $count iteration(s) this run. State in $REPO/state.json, log in $REPO/history.md."
