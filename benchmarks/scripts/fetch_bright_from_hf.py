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
import re
import tempfile

# Pinned Hugging Face commit (issue #1270). This is the xlangai/BRIGHT `main` head
# the committed benchmarks/results/bright/ numbers were computed on. It is
# deliberately NOT the current head: upstream commit c12d4458 (2026-11-07,
# "Correct duplicate and invalid relevance labels in four BRIGHT splits") rewrote
# the biology, earth_science, robotics and stackoverflow `examples` (gold labels).
# Moving the pin to it means re-recording the BRIGHT results.
BRIGHT_REPO = "xlangai/BRIGHT"
BRIGHT_REVISION = "3066d29c9651a576c8aba4832d249807b181ecae"


def _allowed_roots() -> list[str]:
    repo = os.path.realpath(os.path.join(os.path.dirname(__file__), "..", ".."))
    return [
        repo,
        os.path.realpath(os.getcwd()),
        os.path.realpath(tempfile.gettempdir()),
        os.path.realpath(os.path.expanduser("~")),
    ]


def _resolve_path(path_str: str) -> str:
    """Resolve a CLI-supplied path and require it to stay under an allowed root
    (repo checkout, CWD, or the system temp dir)."""
    dest = os.path.realpath(path_str)
    if not any(dest == root or dest.startswith(root + os.sep) for root in _allowed_roots()):
        raise SystemExit(f"[error] refusing path outside allowed roots: {dest}")
    return dest


_SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


def _safe_name(value: str, what: str) -> str:
    if not _SAFE_NAME.match(value) or value in (".", ".."):
        raise SystemExit(f"[error] unsafe {what}: {value!r}")
    return value


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tasks", required=True, help="comma-separated BRIGHT task names")
    ap.add_argument("--bright-dir", required=True)
    args = ap.parse_args()

    from datasets import load_dataset

    tasks = [t.strip() for t in args.tasks.split(",") if t.strip()]
    for task in tasks:
        out = os.path.join(_resolve_path(args.bright_dir), _safe_name(task, "task name"))
        os.makedirs(out, exist_ok=True)
        docs = load_dataset(BRIGHT_REPO, "documents", split=task, revision=BRIGHT_REVISION)
        exs = load_dataset(BRIGHT_REPO, "examples", split=task, revision=BRIGHT_REVISION)
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
        # Provenance sidecar; the bench:bright adapter reads only the two jsonl files.
        with open(os.path.join(out, "source.json"), "w", encoding="utf-8") as f:
            json.dump({"repo": BRIGHT_REPO, "revision": BRIGHT_REVISION, "task": task}, f, indent=2)
            f.write("\n")
        print(f"[done] {task}: documents={len(docs)} examples={n_ex} -> {out} ({BRIGHT_REPO}@{BRIGHT_REVISION})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
