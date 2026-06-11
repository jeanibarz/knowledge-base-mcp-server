#!/usr/bin/env python3
"""Export BRIGHT tasks from the HuggingFace `xlangai/BRIGHT` dataset into the
`--bright-dir` layout the `bench:bright` adapter expects (per the recipe in
benchmarks/bright/README.md):

  <bright-dir>/<task>/documents.jsonl   {"id", "content"}
  <bright-dir>/<task>/examples.jsonl    {"id", "query", "gold_ids", "excluded_ids"}

Only materializes public data into the expected layout — emits no benchmark
numbers and does not touch retrieval/scoring.

Usage:
  python3 benchmarks/scripts/fetch_bright_from_hf.py --tasks biology,economics \
      --bright-dir benchmarks/.cache/bright
"""
from __future__ import annotations

import argparse
import json
import os


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", required=True, help="comma-separated BRIGHT task names")
    ap.add_argument("--bright-dir", required=True)
    args = ap.parse_args()

    from datasets import load_dataset

    tasks = [t.strip() for t in args.tasks.split(",") if t.strip()]
    for task in tasks:
        out = os.path.join(args.bright_dir, task)
        os.makedirs(out, exist_ok=True)
        docs = load_dataset("xlangai/BRIGHT", "documents", split=task)
        exs = load_dataset("xlangai/BRIGHT", "examples", split=task)
        with open(os.path.join(out, "documents.jsonl"), "w", encoding="utf-8") as f:
            for r in docs:
                f.write(json.dumps({"id": str(r["id"]), "content": r["content"]}, ensure_ascii=False) + "\n")
        n_ex = 0
        with open(os.path.join(out, "examples.jsonl"), "w", encoding="utf-8") as f:
            for r in exs:
                f.write(json.dumps({
                    "id": str(r["id"]),
                    "query": r["query"],
                    "gold_ids": [str(g) for g in r["gold_ids"]],
                    "excluded_ids": [str(g) for g in r.get("excluded_ids", [])],
                }, ensure_ascii=False) + "\n")
                n_ex += 1
        print(f"[done] {task}: documents={len(docs)} examples={n_ex} -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
