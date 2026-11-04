#!/usr/bin/env python3
"""Build the vendored, capped NanoBEIR gate fixtures (issue #1051).

NanoBEIR (https://huggingface.co/zeta-alpha-ai) is the official downsized BEIR
(~50 queries/dataset). This script materialises a *further-capped, deterministic*
subset into the `corpus.jsonl` / `queries.jsonl` / `qrels/<split>.tsv` layout the
`benchmarks/beir/run.ts` runner consumes via `--dataset-dir`, so the dense
quality gate runs on REAL text + REAL qrels + REAL embeddings while staying
inside the CI time budget and small enough to vendor.

Downsizing rule (deterministic, stable git diffs):
  * keep ALL queries and ALL qrels pairs (NanoBEIR qrels are binary → score=1);
  * keep EVERY judged doc (so no qrel is orphaned);
  * add unjudged "distractor" docs, chosen by sorted `_id`, up to CORPUS_CAP.

Re-run to refresh:  python3 build-nanobeir-fixtures.py
Baselines are then recorded with a real embedding provider (see the README).
"""
import json, os, sys
from datasets import load_dataset

CORPUS_CAP = 1000
SPLIT = "test"  # NanoBEIR ships a single eval split; the runner reads qrels/<split>.tsv
DATASETS = {
    "nanobeir-scifact": "zeta-alpha-ai/NanoSciFact",
    "nanobeir-fiqa": "zeta-alpha-ai/NanoFiQA2018",
}
OUT_ROOT = os.path.dirname(os.path.abspath(__file__))


def build(name: str, repo: str) -> None:
    corpus = load_dataset(repo, "corpus", split="train")
    queries = load_dataset(repo, "queries", split="train")
    qrels = load_dataset(repo, "qrels", split="train")

    judged = sorted({str(r) for r in qrels["corpus-id"]})
    judged_set = set(judged)
    filler = [cid for cid in sorted(str(i) for i in corpus["_id"]) if cid not in judged_set]
    keep = set(judged) | set(filler[: max(0, CORPUS_CAP - len(judged))])

    text_by_id = {str(i): (t or "") for i, t in zip(corpus["_id"], corpus["text"])}
    out = os.path.join(OUT_ROOT, name)
    os.makedirs(os.path.join(out, "qrels"), exist_ok=True)

    with open(os.path.join(out, "corpus.jsonl"), "w", encoding="utf-8") as f:
        for cid in sorted(keep):
            # NanoBEIR corpus has no title column; the runner treats title as optional.
            f.write(json.dumps({"_id": cid, "title": "", "text": text_by_id[cid]}, ensure_ascii=False) + "\n")

    with open(os.path.join(out, "queries.jsonl"), "w", encoding="utf-8") as f:
        for qid, qtext in sorted(zip((str(i) for i in queries["_id"]), queries["text"])):
            f.write(json.dumps({"_id": qid, "text": qtext}, ensure_ascii=False) + "\n")

    pairs = sorted({(str(q), str(c)) for q, c in zip(qrels["query-id"], qrels["corpus-id"])})
    with open(os.path.join(out, "qrels", f"{SPLIT}.tsv"), "w", encoding="utf-8") as f:
        f.write("query-id\tcorpus-id\tscore\n")
        for q, c in pairs:
            f.write(f"{q}\t{c}\t1\n")

    print(f"{name}: docs={len(keep)} (judged={len(judged)}) queries={queries.num_rows} qrels={len(pairs)}")


if __name__ == "__main__":
    for name, repo in DATASETS.items():
        build(name, repo)
