#!/usr/bin/env python3
"""Materialize a BEIR dataset into the local cache in the on-disk layout the
`bench:beir` runner expects (`<cache>/<dataset>/{corpus.jsonl,queries.jsonl,
qrels/<split>.tsv}`), sourcing from the HuggingFace `BeIR/*` mirror.

The runner's built-in `DATASET_URLS` point at the TU-Darmstadt zip host, which is
not always reachable. The runner reuses an already-populated cache dir without
downloading (see `ensureDataset`/`datasetExists` in `benchmarks/beir/run.ts`), so
pre-populating the cache here lets the real benchmark run unchanged. This script
ONLY converts public data into the expected layout — it does not touch retrieval
or scoring, and writes no benchmark numbers.

Usage:
  python3 benchmarks/scripts/fetch_beir_from_hf.py --dataset scifact --split test \
      --cache-dir /home/jean/.cache/kb-beir-cache
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
import urllib.request

import pandas as pd

HF_BASE = "https://huggingface.co"

# Most BeIR datasets live at BeIR/<name> with a sibling BeIR/<name>-qrels repo.
# A few use a different corpus/qrels repo name on the hub; record those here.
QRELS_REPO_OVERRIDE: dict[str, str] = {}


def _hf_api(path: str) -> dict:
    url = f"{HF_BASE}/api/datasets/{path}"
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def _siblings(repo: str) -> list[str]:
    return [s["rfilename"] for s in _hf_api(repo).get("siblings", [])]


def _download(url: str, dest: str) -> None:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with urllib.request.urlopen(url, timeout=600) as r:
        data = r.read()
    with open(dest, "wb") as f:
        f.write(data)


def _read_parquet_shards(repo: str, files: list[str]) -> pd.DataFrame:
    frames = []
    for fn in files:
        url = f"{HF_BASE}/datasets/{repo}/resolve/main/{fn}"
        with urllib.request.urlopen(url, timeout=600) as r:
            buf = io.BytesIO(r.read())
        frames.append(pd.read_parquet(buf))
    return pd.concat(frames, ignore_index=True) if len(frames) > 1 else frames[0]


def _write_jsonl(df: pd.DataFrame, fields: list[str], dest: str) -> int:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    # NOTE: do not use df.itertuples() — it renames leading-underscore columns
    # (`_id`) to positional names. to_dict("records") preserves real names.
    n = 0
    with open(dest, "w", encoding="utf-8") as f:
        for d in df.to_dict("records"):
            obj = {}
            for k in fields:
                v = d.get(k, "")
                if v is None:
                    v = ""
                obj[k] = v
            obj["_id"] = str(obj["_id"])
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
            n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", required=True)
    ap.add_argument("--split", default="test")
    ap.add_argument("--cache-dir", required=True)
    ap.add_argument("--corpus-repo", default=None, help="HF repo id; default BeIR/<dataset>")
    ap.add_argument("--qrels-repo", default=None, help="HF repo id; default BeIR/<dataset>-qrels")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    ds = args.dataset
    corpus_repo = args.corpus_repo or f"BeIR/{ds}"
    qrels_repo = args.qrels_repo or QRELS_REPO_OVERRIDE.get(ds, f"BeIR/{ds}-qrels")
    out_dir = os.path.join(args.cache_dir, ds)
    corpus_path = os.path.join(out_dir, "corpus.jsonl")
    queries_path = os.path.join(out_dir, "queries.jsonl")
    qrels_path = os.path.join(out_dir, "qrels", f"{args.split}.tsv")

    if (not args.force) and all(os.path.exists(p) for p in (corpus_path, queries_path, qrels_path)):
        print(f"[skip] {ds}: cache already populated at {out_dir}")
        return 0

    print(f"[fetch] {ds}: corpus/queries from {corpus_repo}, qrels from {qrels_repo}")
    sib = _siblings(corpus_repo)
    corpus_files = sorted(f for f in sib if f.startswith("corpus/") and f.endswith(".parquet"))
    queries_files = sorted(f for f in sib if f.startswith("queries/") and f.endswith(".parquet"))
    if not corpus_files or not queries_files:
        # Some repos store flat corpus.jsonl(.gz) instead of parquet shards.
        print(f"[error] {ds}: no parquet shards found in {corpus_repo}; siblings={sib}", file=sys.stderr)
        return 2

    print(f"  corpus shards: {len(corpus_files)}; query shards: {len(queries_files)}")
    corpus_df = _read_parquet_shards(corpus_repo, corpus_files)
    queries_df = _read_parquet_shards(corpus_repo, queries_files)

    # Normalize column names to BEIR: _id, title, text.
    corpus_df = corpus_df.rename(columns={"id": "_id"})
    queries_df = queries_df.rename(columns={"id": "_id"})
    for col in ("_id", "text"):
        if col not in corpus_df.columns:
            raise SystemExit(f"corpus missing column {col}: {list(corpus_df.columns)}")
    if "title" not in corpus_df.columns:
        corpus_df["title"] = ""

    n_corpus = _write_jsonl(corpus_df, ["_id", "title", "text"], corpus_path)
    n_queries = _write_jsonl(queries_df, ["_id", "text"], queries_path)

    # qrels: a flat <split>.tsv in the qrels repo.
    qsib = _siblings(qrels_repo)
    tsv_name = f"{args.split}.tsv"
    if tsv_name not in qsib:
        print(f"[error] {ds}: {tsv_name} not in {qrels_repo}; siblings={qsib}", file=sys.stderr)
        return 3
    _download(f"{HF_BASE}/datasets/{qrels_repo}/resolve/main/{tsv_name}", qrels_path)
    with open(qrels_path, encoding="utf-8") as f:
        n_qrels = sum(1 for ln in f if ln.strip()) - 1  # minus header

    print(f"[done] {ds}: corpus={n_corpus} queries={n_queries} qrels_rows~={n_qrels} -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
