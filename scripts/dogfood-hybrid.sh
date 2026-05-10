#!/usr/bin/env bash
#
# Dogfood `kb search --mode=hybrid` against `--mode=dense` on real KBs.
# Issue #206 stage 2 / ADR 0006 reproducibility script.
#
# Runs a curated query set in both modes against KBs whose lexical index is
# already built (or builds it on first run via `--refresh`), captures top-K
# source paths per mode, and tallies recall against an "expected" source for
# each gated query. Reports a per-query breakdown plus a summary so reviewers
# can re-run the empirical lift evidence attached to PR #224.
#
# Usage:
#   scripts/dogfood-hybrid.sh                 # use the default query bundle
#   QUERIES_FILE=my.tsv scripts/dogfood-hybrid.sh   # custom bundle
#   KB_BIN=./build/cli.js scripts/dogfood-hybrid.sh # explicit cli location
#
# Query bundle file format (TSV; pipes accepted as the v1 separator):
#   <kb>|<kind>|<query>|<expected_substring>
# Lines starting with `#` are skipped. `<expected_substring>` may be empty —
# such queries are reported as informational ("—" in the dense/hybrid columns).
#
# Exit code: 0 if no regressions (hybrid never strictly worse than dense for a
# gated query), 1 otherwise. Lifts are not required — a no-op tie matrix still
# exits 0.
#
# Defaults assume the KBs at ~/knowledge_bases/ and a globally-installed `kb`
# bin. Override KNOWLEDGE_BASES_ROOT_DIR / FAISS_INDEX_PATH via env if your
# layout differs (the same env vars the server reads).

set -euo pipefail

KB_BIN="${KB_BIN:-$(command -v kb || true)}"
if [ -z "${KB_BIN}" ] || [ ! -x "${KB_BIN}" ]; then
  # Fall back to the local build inside this checkout.
  here_build="$(cd "$(dirname "$0")/.." && pwd)/build/cli.js"
  if [ -x "$here_build" ] || [ -f "$here_build" ]; then
    KB_BIN="$here_build"
  fi
fi
if [ -z "${KB_BIN}" ] || [ ! -e "${KB_BIN}" ]; then
  echo "dogfood-hybrid: cannot find kb. Set KB_BIN or install/build first." >&2
  exit 2
fi

INVOKE=(node "$KB_BIN")
case "$KB_BIN" in
  */kb|kb) INVOKE=("$KB_BIN") ;;     # bin shim, run directly
esac

K="${TOP_K:-5}"
QUERIES_FILE="${QUERIES_FILE:-}"

# Default bundle. The exact-token queries below are the ones referenced in
# PR #224's empirical evidence comment; tweak via QUERIES_FILE for another
# corpus.
DEFAULT_BUNDLE="$(cat <<'EOF'
arxiv-llm-inference|exact|DeepSeekMoE|2605.05693
arxiv-llm-inference|exact|SpikingBrain|2604.22575
arxiv-llm-inference|exact|SSE-SWA|2604.22575
llm-memory|exact|SecureBERT 2.0|2604.17948
llm-memory|exact|Falcon H1R|2604.17948
llm-memory|exact|Reciprocal Rank Fusion|
arxiv-llm-inference|paraphrase|how does mixture of experts speed up inference|
arxiv-llm-inference|paraphrase|sparse attention with brain-inspired memory gating|2604.22575
llm-memory|paraphrase|hybrid retrieval beats dense alone for code reasoning|2604.17948
llm-memory|paraphrase|hierarchical memory architecture for long context LLMs|
llm-as-judge|paraphrase|how to evaluate LLM judges for bias|
llm-reasoning|paraphrase|chain of thought versus tree search for reasoning|
EOF
)"

if [ -n "$QUERIES_FILE" ]; then
  if [ ! -r "$QUERIES_FILE" ]; then
    echo "dogfood-hybrid: QUERIES_FILE not readable: $QUERIES_FILE" >&2
    exit 2
  fi
  BUNDLE="$(grep -vE '^[[:space:]]*(#|$)' "$QUERIES_FILE")"
else
  BUNDLE="$DEFAULT_BUNDLE"
fi

# Run kb search; print top-K relativePath values, one per line.
run_mode() {
  local kb=$1 query=$2 mode=$3
  "${INVOKE[@]}" search "$query" --kb="$kb" --mode="$mode" --k="$K" --format=json 2>/dev/null \
    | jq -r '.results[]?.metadata.relativePath // empty' 2>/dev/null \
    | head -"$K"
}

# Find rank (1..K) of an expected substring in a list of source paths; 0 if
# absent; "-" if no expected was supplied.
find_rank() {
  local expected=$1 sources=$2
  [ -z "$expected" ] && { echo "-"; return; }
  local rank=1
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if [[ "$line" == *"$expected"* ]]; then
      echo "$rank"
      return
    fi
    rank=$((rank + 1))
  done <<< "$sources"
  echo 0
}

printf "| %-22s | %-12s | %-50s | %-12s | dense | hybrid |\n" "KB" "Kind" "Query" "Expected"
printf "|------------------------|--------------|----------------------------------------------------|--------------|-------|--------|\n"

dense_finds=0
hybrid_finds=0
hybrid_lifts=0
hybrid_regress=0
hybrid_better=0
dense_better=0
ties=0
neither=0
gated=0

while IFS='|' read -r kb kind query expected; do
  [ -z "$kb" ] && continue
  dense_top=$(run_mode "$kb" "$query" dense)
  hybrid_top=$(run_mode "$kb" "$query" hybrid)
  dense_rank=$(find_rank "$expected" "$dense_top")
  hybrid_rank=$(find_rank "$expected" "$hybrid_top")

  if [ -n "$expected" ]; then
    gated=$((gated + 1))
    [ "$dense_rank" != "0" ] && dense_finds=$((dense_finds + 1))
    [ "$hybrid_rank" != "0" ] && hybrid_finds=$((hybrid_finds + 1))
    if [ "$dense_rank" = "0" ] && [ "$hybrid_rank" != "0" ]; then
      hybrid_lifts=$((hybrid_lifts + 1))
    elif [ "$dense_rank" != "0" ] && [ "$hybrid_rank" = "0" ]; then
      hybrid_regress=$((hybrid_regress + 1))
    elif [ "$dense_rank" = "0" ] && [ "$hybrid_rank" = "0" ]; then
      neither=$((neither + 1))
    elif [ "$dense_rank" = "$hybrid_rank" ]; then
      ties=$((ties + 1))
    elif [ "$hybrid_rank" -lt "$dense_rank" ] 2>/dev/null; then
      hybrid_better=$((hybrid_better + 1))
    else
      dense_better=$((dense_better + 1))
    fi
    dense_label=$([ "$dense_rank" = "0" ] && echo "miss" || echo "@$dense_rank")
    hybrid_label=$([ "$hybrid_rank" = "0" ] && echo "miss" || echo "@$hybrid_rank")
  else
    dense_label="—"
    hybrid_label="—"
  fi
  printf "| %-22s | %-12s | %-50s | %-12s | %5s | %6s |\n" \
    "$kb" "$kind" "$(printf '%s' "$query" | cut -c1-50)" "$expected" \
    "$dense_label" "$hybrid_label"
done <<< "$BUNDLE"

echo ""
echo "Summary on the gated subset (queries with an expected source):"
echo "  hybrid_lifts:    $hybrid_lifts (hybrid found, dense missed)"
echo "  hybrid_better:   $hybrid_better (both found, hybrid ranked higher)"
echo "  ties:            $ties"
echo "  dense_better:    $dense_better (both found, dense ranked higher)"
echo "  hybrid_regress:  $hybrid_regress (dense found, hybrid missed)"
echo "  neither_found:   $neither"
echo ""
echo "  dense recall:    $dense_finds / $gated expected"
echo "  hybrid recall:   $hybrid_finds / $gated expected"

# Exit non-zero only on a regression — recall ties are fine; lifts are bonus.
if [ "$hybrid_regress" -gt 0 ] || [ "$dense_better" -gt 0 ]; then
  echo ""
  echo "FAIL: hybrid retrieval shows ${hybrid_regress} regression(s) and ${dense_better} cases where dense ranked the expected source higher." >&2
  exit 1
fi
