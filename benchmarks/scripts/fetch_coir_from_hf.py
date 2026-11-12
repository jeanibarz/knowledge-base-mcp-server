#!/usr/bin/env python3
"""Materialize a CoIR (Code Information Retrieval) dataset into the BEIR on-disk
layout the `bench:beir` runner expects (`<cache>/<dataset>/{corpus.jsonl,
queries.jsonl,qrels/<split>.tsv}`).

CoIR (arXiv 2407.02883) publishes each dataset as one HuggingFace repo
`CoIR-Retrieval/<name>` with parquet shards:
  corpus/*.parquet   -> _id, text, title, ...
  queries/*.parquet  -> _id, text, ...
  data/<split>.parquet -> query-id, corpus-id, score   (the qrels)
This script only converts that layout to BEIR; it does not touch retrieval or
scoring and writes no benchmark numbers. It reuses the helpers of
`fetch_beir_from_hf.py` (path confinement, name sanitising, jsonl writer).

Usage:
  python3 benchmarks/scripts/fetch_coir_from_hf.py --dataset cosqa --split test \
      --cache-dir ~/.cache/kb-beir-cache
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fetch_beir_from_hf import (  # noqa: E402
    _read_parquet_shards,
    _resolve_path,
    _safe_name,
    _siblings,
    _write_jsonl,
)

# CoIR repo ids are case-sensitive (e.g. `CodeSearchNet-python`), so the
# registry name maps 1:1 onto the hub name unless overridden here.
REPO_PREFIX = "CoIR-Retrieval/"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--split", default="test")
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--repo", default=None, help="HF repo id; default CoIR-Retrieval/<dataset>")
    ap.add_argument(
        "--max-query-chars",
        type=int,
        default=0,
        help="truncate each query to this many characters (0 = no truncation). Code-to-code and "
        "StackOverflow queries are whole snippets, and the dense/hybrid path embeds a query "
        "unchunked, so a query past the embedding model's context window makes the provider "
        "reject the request. Truncate and record the cap alongside the results.",
    )
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    ds = _safe_name(args.dataset, "dataset name")
    split = _safe_name(args.split, "split")
    repo = args.repo or f"{REPO_PREFIX}{ds}"
    out_dir = os.path.join(_resolve_path(args.cache_dir), ds)
    corpus_path = os.path.join(out_dir, "corpus.jsonl")
    queries_path = os.path.join(out_dir, "queries.jsonl")
    qrels_path = os.path.join(out_dir, "qrels", f"{split}.tsv")

    if (not args.force) and all(os.path.exists(p) for p in (corpus_path, queries_path, qrels_path)):
        print(f"[skip] {ds}: cache already populated at {out_dir}")
        return 0

    sib = _siblings(repo)
    corpus_files = sorted(f for f in sib if f.startswith("corpus/") and f.endswith(".parquet"))
    queries_files = sorted(f for f in sib if f.startswith("queries/") and f.endswith(".parquet"))
    qrels_files = sorted(f for f in sib if f.startswith(f"data/{split}-") and f.endswith(".parquet"))
    if not (corpus_files and queries_files and qrels_files):
        print(f"[error] {ds}: missing corpus/queries/data/{split} parquet in {repo}; siblings={sib}", file=sys.stderr)
        return 2

    corpus_df = _read_parquet_shards(repo, corpus_files)
    queries_df = _read_parquet_shards(repo, queries_files)
    qrels_df = _read_parquet_shards(repo, qrels_files)

    for col in ("_id", "text"):
        for name, df in (("corpus", corpus_df), ("queries", queries_df)):
            if col not in df.columns:
                raise SystemExit(f"{name} missing column {col}: {list(df.columns)}")
    if "title" not in corpus_df.columns:
        corpus_df["title"] = ""
    for col in ("query-id", "corpus-id", "score"):
        if col not in qrels_df.columns:
            raise SystemExit(f"qrels missing column {col}: {list(qrels_df.columns)}")

    if args.max_query_chars > 0:
        n_cut = int((queries_df["text"].str.len() > args.max_query_chars).sum())
        queries_df["text"] = queries_df["text"].str.slice(0, args.max_query_chars)
        print(f"  truncated {n_cut} queries to {args.max_query_chars} chars")

    n_corpus = _write_jsonl(corpus_df, ["_id", "title", "text"], corpus_path)
    n_queries = _write_jsonl(queries_df, ["_id", "text"], queries_path)

    os.makedirs(os.path.dirname(qrels_path), exist_ok=True)
    with open(qrels_path, "w", encoding="utf-8") as f:
        f.write("query-id\tcorpus-id\tscore\n")
        for row in qrels_df.to_dict("records"):
            f.write(f"{row['query-id']}\t{row['corpus-id']}\t{int(row['score'])}\n")

    print(f"[done] {ds}: corpus={n_corpus} queries={n_queries} qrels_rows={len(qrels_df)} -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
