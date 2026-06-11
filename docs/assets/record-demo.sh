#!/usr/bin/env bash
# Regenerates docs/assets/demo.{cast,svg} (issue #40).
#
# Every command in the capture runs for real against a throwaway knowledge
# base seeded from this repo's own docs/ — only the prompt typing is
# simulated. Requirements: a local Ollama with the default embedding model
# pulled, `pip install asciinema`, and npx (svg-term-cli is fetched on demand).
#
# Usage: bash docs/assets/record-demo.sh   (from the repo root)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEMO_ROOT="$(mktemp -d /tmp/kb-demo.XXXXXX)"
trap 'rm -rf "$DEMO_ROOT"' EXIT

export KNOWLEDGE_BASES_ROOT_DIR="$DEMO_ROOT/knowledge_bases"
export FAISS_INDEX_PATH="$DEMO_ROOT/.faiss"
export EMBEDDING_PROVIDER=ollama
export OLLAMA_MODEL='dengcao/Qwen3-Embedding-0.6B:Q8_0'
export LOG_LEVEL=warn

mkdir -p "$KNOWLEDGE_BASES_ROOT_DIR/project-docs" "$FAISS_INDEX_PATH"
cp "$REPO_ROOT/docs/clients.md" \
   "$REPO_ROOT/docs/authoring-knowledge.md" \
   "$REPO_ROOT/docs/search-neighbor-context.md" \
   "$KNOWLEDGE_BASES_ROOT_DIR/project-docs/"

# One-time model registration + index build, outside the capture.
kb models add ollama "$OLLAMA_MODEL" --yes

SCRIPT="$DEMO_ROOT/demo-session.sh"
cat > "$SCRIPT" <<'SESSION'
type_cmd() {
  printf '\033[1;36m$\033[0m '
  local cmd="$1"
  for ((i = 0; i < ${#cmd}; i++)); do
    printf '%s' "${cmd:$i:1}"
    sleep 0.02
  done
  sleep 0.4
  printf '\n'
}

sleep 0.5
type_cmd 'kb list'
kb list
sleep 1.4

type_cmd 'kb search "how do I wire the server into Claude Desktop?" --k=1'
kb search "how do I wire the server into Claude Desktop?" --k=1
sleep 2.8

type_cmd 'kb search "show adjacent chunks around a hit" --format=compact --k=5'
kb search "show adjacent chunks around a hit" --format=compact --k=5
sleep 3.5
SESSION

asciinema rec --overwrite \
  --command="bash $SCRIPT" \
  --title="knowledge-base-mcp-server — kb CLI demo" \
  "$REPO_ROOT/docs/assets/demo.cast"

npx --yes svg-term-cli \
  --in "$REPO_ROOT/docs/assets/demo.cast" \
  --out "$REPO_ROOT/docs/assets/demo.svg" \
  --window --no-optimize

echo "Wrote docs/assets/demo.cast and docs/assets/demo.svg"
