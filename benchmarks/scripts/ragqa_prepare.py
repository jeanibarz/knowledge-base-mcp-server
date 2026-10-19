#!/usr/bin/env python3
"""Prepare HotpotQA (distractor) data for the RFC 020 §5 end-to-end RAG eval.

Streams the public HotpotQA distractor validation split from the HuggingFace
mirror (no full download), takes the first N items, and emits:

  1. <data-dir>/hotpotqa.jsonl  — gold-QA rows the rag-eval loader consumes:
       {"id", "question", "answer", "supporting_facts": [gold sentence strings]}
  2. <docs-dir>/<safe_para_id>.md — one markdown file per distinct context
     paragraph across the selected items (the shared retrieval corpus a real
     `kb ask` retrieves from).
  3. <data-dir>/hotpotqa_paramap.json — {paragraph_id -> text} so the answer
     generator can map `kb ask` citation paths back to retrieved context text.

This only materializes public data into the on-disk shapes the harness expects.
It produces NO eval numbers and does not touch retrieval/scoring/LLM calls.

Usage:
  python3 benchmarks/scripts/ragqa_prepare.py --n 150 \
      --data-dir benchmarks/.cache/rag-eval \
      --docs-dir benchmarks/.cache/rag-eval/hotpotqa-docs
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re


def safe_id(raw: str) -> str:
    keep = re.sub(r"[^A-Za-z0-9._-]+", "_", raw).strip("_")[:60]
    suffix = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:10]
    return f"{keep or 'p'}-{suffix}"


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
    ap.add_argument("--n", type=int, default=150)
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--docs-dir", required=True)
    ap.add_argument("--split", default="validation")
    args = ap.parse_args()

    from datasets import load_dataset

    data_dir = _resolve_path(args.data_dir)
    docs_dir = _resolve_path(args.docs_dir)
    os.makedirs(data_dir, exist_ok=True)
    os.makedirs(docs_dir, exist_ok=True)

    ds = load_dataset("hotpotqa/hotpot_qa", "distractor", split=_safe_name(args.split, "split"), streaming=True)

    gold_path = os.path.join(data_dir, "hotpotqa.jsonl")
    paramap: dict[str, str] = {}
    n_written = 0

    with open(gold_path, "w", encoding="utf-8") as gf:
        for row in ds:
            if n_written >= args.n:
                break
            qid = str(row["id"])
            question = row["question"]
            answer = row["answer"]

            # context: {"title": [t...], "sentences": [[s...], ...]}
            ctx = row["context"]
            titles = ctx["title"]
            sentences = ctx["sentences"]
            title_to_sents = {t: s for t, s in zip(titles, sentences)}

            # supporting_facts: {"title": [t...], "sent_id": [i...]}
            sf = row["supporting_facts"]
            gold_sents: list[str] = []
            for t, sid in zip(sf["title"], sf["sent_id"]):
                sents = title_to_sents.get(t)
                if sents is not None and 0 <= sid < len(sents):
                    s = sents[sid].strip()
                    if s:
                        gold_sents.append(s)

            # Materialize each context paragraph (one md file per paragraph).
            for t, sents in zip(titles, sentences):
                para = " ".join(s.strip() for s in sents).strip()
                if not para:
                    continue
                pid = safe_id(f"{qid}::{t}")
                if pid not in paramap:
                    paramap[pid] = para
                    doc_path = os.path.join(docs_dir, f"{pid}.md")
                    with open(doc_path, "w", encoding="utf-8") as df:
                        df.write(f"# {t}\n\n{para}\n")

            gf.write(json.dumps({
                "id": qid,
                "question": question,
                "answer": answer,
                "supporting_facts": gold_sents,
            }, ensure_ascii=False) + "\n")
            n_written += 1

    with open(os.path.join(data_dir, "hotpotqa_paramap.json"), "w", encoding="utf-8") as pf:
        json.dump(paramap, pf, ensure_ascii=False)

    print(f"[done] hotpotqa: items={n_written} paragraphs={len(paramap)} "
          f"-> gold={gold_path}, docs={docs_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
