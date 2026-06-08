#!/usr/bin/env python3
"""Generate real `kb ask` answers for the RFC 020 §5 RAG eval (offline answer
production step). Drives the PRODUCT `kb ask` CLI — not a benchmark-only
reimplementation — over the HotpotQA gold questions, against a KB built from the
materialized context paragraphs, and emits the `{id, answer, contexts}` JSONL
the rag-eval runner consumes via `--answers`.

Retrieval embeddings come from Ollama (EMBEDDING_PROVIDER/OLLAMA_MODEL); the
answer LLM comes from the configured provider (KB_LLM_PROVIDER=openrouter +
KB_OPENROUTER_API_KEY, here DeepSeek). `kb ask --format=json` returns the answer
plus citations (KB-relative paths); we map each citation path back to its source
paragraph text (via the paramap) to populate `contexts[].text`, which Tier 1
scores for context recall/precision against the gold supporting facts.

Usage (env must carry the embedding + LLM provider config — the CLI does NOT
auto-load .env):
  python3 benchmarks/scripts/ragqa_generate_answers.py \
      --gold benchmarks/.cache/rag-eval/hotpotqa.jsonl \
      --paramap benchmarks/.cache/rag-eval/hotpotqa_paramap.json \
      --kb-root benchmarks/.cache/rag-eval --kb hotpotqa-docs \
      --faiss-index /tmp/ragqa-faiss \
      --endpoint https://openrouter.ai/api/v1 \
      --answerer-model deepseek/deepseek-v4-flash \
      --out benchmarks/results/rag-eval/answers-hotpotqa.jsonl \
      --n 150
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys


def run_ask(cli: str, question: str, kb: str, endpoint: str, model: str, env: dict,
            refresh: bool, k: int) -> dict:
    cmd = ["node", cli, "ask", question, f"--kb={kb}", "--format=json",
           f"--endpoint={endpoint}", f"--k={k}"]
    if refresh:
        cmd.append("--refresh")
    proc = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=600)
    if proc.returncode != 0:
        raise RuntimeError(f"kb ask failed (rc={proc.returncode}): {proc.stderr[-800:]}")
    # stdout may carry log noise before the JSON object; find the first '{'.
    out = proc.stdout
    start = out.find("{")
    if start < 0:
        raise RuntimeError(f"no JSON in kb ask output: {out[-400:]}")
    return json.loads(out[start:])


def citation_to_pid(path: str) -> str:
    base = os.path.basename(path)
    return base[:-3] if base.endswith(".md") else base


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gold", required=True)
    ap.add_argument("--paramap", required=True)
    ap.add_argument("--kb-root", required=True)
    ap.add_argument("--kb", required=True)
    ap.add_argument("--faiss-index", required=True)
    ap.add_argument("--endpoint", required=True)
    ap.add_argument("--answerer-model", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--cli", default="build/cli.js")
    ap.add_argument("--n", type=int, default=0, help="0 = all")
    ap.add_argument("--k", type=int, default=8)
    args = ap.parse_args()

    with open(args.paramap, encoding="utf-8") as f:
        paramap = json.load(f)

    items = []
    with open(args.gold, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                items.append(json.loads(line))
    if args.n > 0:
        items = items[: args.n]

    env = dict(os.environ)
    env["KNOWLEDGE_BASES_ROOT_DIR"] = os.path.abspath(args.kb_root)
    env["FAISS_INDEX_PATH"] = os.path.abspath(args.faiss_index)
    env.setdefault("EMBEDDING_PROVIDER", "ollama")
    env["KB_LLM_PROVIDER"] = env.get("KB_LLM_PROVIDER", "openrouter")
    env["KB_LLM_MODEL"] = args.answerer_model

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)

    written = 0
    errors = 0
    with open(args.out, "w", encoding="utf-8") as outf:
        for idx, item in enumerate(items):
            qid = str(item["id"])
            question = item["question"]
            try:
                res = run_ask(args.cli, question, args.kb, args.endpoint,
                              args.answerer_model, env, refresh=(idx == 0), k=args.k)
            except Exception as e:  # noqa: BLE001 — record + continue, never fabricate
                errors += 1
                print(f"[warn] {qid}: {e}", file=sys.stderr)
                continue

            answer = res.get("answer", "") or ""
            contexts = []
            seen = set()
            for cit in res.get("citations", []) or []:
                p = cit.get("path", "")
                pid = citation_to_pid(p)
                if pid in seen:
                    continue
                seen.add(pid)
                text = paramap.get(pid, "")
                contexts.append({"id": p or pid, "text": text})

            outf.write(json.dumps({"id": qid, "answer": answer, "contexts": contexts},
                                  ensure_ascii=False) + "\n")
            outf.flush()
            written += 1
            if written % 10 == 0:
                print(f"  ... {written}/{len(items)} answered ({errors} errors)")

    print(f"[done] answers={written} errors={errors} -> {args.out}")
    return 0 if written > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
