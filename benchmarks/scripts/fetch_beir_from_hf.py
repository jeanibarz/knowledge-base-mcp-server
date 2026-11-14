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
import re
import tempfile
import urllib.request

import pandas as pd

HF_BASE = "https://huggingface.co"

# Most BeIR datasets live at BeIR/<name> with a sibling BeIR/<name>-qrels repo.
# A few use a different corpus/qrels repo name on the hub; record those here.
QRELS_REPO_OVERRIDE: dict[str, str] = {}

# Pinned Hugging Face commit SHAs (issue #1270). Every file is fetched from
# `resolve/<sha>/...`, so a new upstream commit cannot silently change the corpus
# or qrels that the committed `benchmarks/results/beir/` numbers were computed on.
# These are the `main` heads the committed results were recorded against (the
# corpus repos' last commit is the 2026-04-09 parquet conversion; the qrels repos
# have not changed since 2022). To move a pin, look up the new SHA with
#   curl -fsS https://huggingface.co/api/datasets/<repo>/revision/main | jq -r .sha
# and re-record the affected results.
PINNED_REVISIONS: dict[str, str] = {
    "BeIR/scifact": "b3b5335604bf5ee3c4447671af975ea25143d4f5",
    "BeIR/scifact-qrels": "2938d17dc3b09882fdb8c12bbbe2e2dc0e75a029",
    "BeIR/nfcorpus": "b5026a0e96e8a7ac4f95f482a596389289d46269",
    "BeIR/nfcorpus-qrels": "a451b3b26d3ae1358f259c1a3a4dd61fcea35a65",
    "BeIR/fiqa": "979c07a7cb5ccc6ca009792241fa1250b98055dd",
    "BeIR/fiqa-qrels": "252958f2d646e22cab6d0c72dd3f0d5de6d0655a",
    "BeIR/arguana": "9bcf8fc0320c4e3860e25b8b85fa205fcdd7078f",
    "BeIR/arguana-qrels": "ae5468c6f1c198109a8af5f0d4dc58bd18b6fea7",
    "BeIR/scidocs": "acebceec772628c6679d76d6cff30ad517d17f4e",
    "BeIR/scidocs-qrels": "735ea1048e37b1ebce14c6dc3d33a5edaf66d3dc",
}

_SHA = re.compile(r"^[0-9a-f]{40}$")


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



def _hf_api(path: str) -> dict:
    url = f"{HF_BASE}/api/datasets/{path}"
    with urllib.request.urlopen(url, timeout=60) as r:
        return json.load(r)


def _check_sha(value: str, what: str) -> str:
    if not _SHA.match(value):
        raise SystemExit(f"[error] {what} must be a 40-character lowercase commit SHA, got {value!r}")
    return value


def resolve_revision(repo: str, override: str | None = None) -> str:
    """Return the commit SHA to fetch `repo` at.

    Order: an explicit `override`, then `PINNED_REVISIONS`, then (for a repo with
    no pin) the current `main` head resolved once to a SHA, so every file of one
    run still comes from a single consistent snapshot and the SHA is printed for
    the record.
    """
    if override is not None:
        return _check_sha(override, f"revision for {repo}")
    pinned = PINNED_REVISIONS.get(repo)
    if pinned:
        return pinned
    sha = _check_sha(str(_hf_api(f"{repo}/revision/main").get("sha", "")), f"main head of {repo}")
    print(f"[warn] {repo} has no pinned revision; using current main {sha}. "
          f"Add it to PINNED_REVISIONS to make this fetch reproducible.", file=sys.stderr)
    return sha


def _warn_if_cache_off_pin(source_path: str, wanted: dict[str, tuple[str, str | None]]) -> None:
    """On a cache hit, warn when the cached files are not provably at the expected
    revision (no sidecar, or a sidecar naming a different SHA). Offline: an unpinned
    repo with no override has no expected SHA to compare against."""
    try:
        with open(source_path, encoding="utf-8") as f:
            recorded = json.load(f)
    except (OSError, ValueError):
        recorded = None
    for part, (repo, override) in wanted.items():
        expected = _check_sha(override, f"revision for {repo}") if override is not None else PINNED_REVISIONS.get(repo)
        got = (recorded or {}).get(part, {})
        if recorded is None or got.get("repo") != repo or (expected and got.get("revision") != expected):
            print(f"[warn] cached {part} is not recorded at {repo}@{expected or '<unpinned>'} "
                  f"(sidecar: {got.get('repo')}@{got.get('revision')}); re-run with --force to fetch it.",
                  file=sys.stderr)


def _siblings(repo: str, revision: str = "main") -> list[str]:
    return [s["rfilename"] for s in _hf_api(f"{repo}/revision/{revision}").get("siblings", [])]


def _download(url: str, dest: str) -> None:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with urllib.request.urlopen(url, timeout=600) as r:
        data = r.read()
    with open(dest, "wb") as f:
        f.write(data)


def _read_parquet_shards(repo: str, files: list[str], revision: str = "main") -> pd.DataFrame:
    frames = []
    for fn in files:
        url = f"{HF_BASE}/datasets/{repo}/resolve/{revision}/{fn}"
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
    ap.add_argument("--corpus-revision", default=None,
                    help="commit SHA of the corpus repo; default: PINNED_REVISIONS, else current main")
    ap.add_argument("--qrels-revision", default=None,
                    help="commit SHA of the qrels repo; default: PINNED_REVISIONS, else current main")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    ds = args.dataset
    corpus_repo = args.corpus_repo or f"BeIR/{ds}"
    qrels_repo = args.qrels_repo or QRELS_REPO_OVERRIDE.get(ds, f"BeIR/{ds}-qrels")
    out_dir = os.path.join(_resolve_path(args.cache_dir), _safe_name(ds, "dataset name"))
    corpus_path = os.path.join(out_dir, "corpus.jsonl")
    queries_path = os.path.join(out_dir, "queries.jsonl")
    qrels_path = os.path.join(out_dir, "qrels", f"{args.split}.tsv")

    source_path = os.path.join(out_dir, "hf_source.json")

    if (not args.force) and all(os.path.exists(p) for p in (corpus_path, queries_path, qrels_path)):
        print(f"[skip] {ds}: cache already populated at {out_dir}")
        _warn_if_cache_off_pin(source_path, {
            "corpus": (corpus_repo, args.corpus_revision),
            "qrels": (qrels_repo, args.qrels_revision),
        })
        return 0

    # Drop the old provenance record first, so a fetch that fails part-way never
    # leaves a sidecar naming a revision the files on disk no longer match.
    if os.path.exists(source_path):
        os.remove(source_path)

    corpus_rev = resolve_revision(corpus_repo, args.corpus_revision)
    qrels_rev = resolve_revision(qrels_repo, args.qrels_revision)
    print(f"[fetch] {ds}: corpus/queries from {corpus_repo}@{corpus_rev}, qrels from {qrels_repo}@{qrels_rev}")
    sib = _siblings(corpus_repo, corpus_rev)
    corpus_files = sorted(f for f in sib if f.startswith("corpus/") and f.endswith(".parquet"))
    queries_files = sorted(f for f in sib if f.startswith("queries/") and f.endswith(".parquet"))
    if not corpus_files or not queries_files:
        # Some repos store flat corpus.jsonl(.gz) instead of parquet shards.
        print(f"[error] {ds}: no parquet shards found in {corpus_repo}; siblings={sib}", file=sys.stderr)
        return 2

    print(f"  corpus shards: {len(corpus_files)}; query shards: {len(queries_files)}")
    corpus_df = _read_parquet_shards(corpus_repo, corpus_files, corpus_rev)
    queries_df = _read_parquet_shards(corpus_repo, queries_files, corpus_rev)

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
    qsib = _siblings(qrels_repo, qrels_rev)
    tsv_name = f"{_safe_name(args.split, 'split')}.tsv"
    if tsv_name not in qsib:
        print(f"[error] {ds}: {tsv_name} not in {qrels_repo}; siblings={qsib}", file=sys.stderr)
        return 3
    _download(f"{HF_BASE}/datasets/{qrels_repo}/resolve/{qrels_rev}/{tsv_name}", qrels_path)
    with open(qrels_path, encoding="utf-8") as f:
        n_qrels = sum(1 for ln in f if ln.strip()) - 1  # minus header

    # Provenance sidecar; the runner only reads corpus/queries/qrels and ignores it.
    with open(source_path, "w", encoding="utf-8") as f:
        json.dump({
            "corpus": {"repo": corpus_repo, "revision": corpus_rev},
            "qrels": {"repo": qrels_repo, "revision": qrels_rev, "file": tsv_name},
        }, f, indent=2)
        f.write("\n")

    print(f"[done] {ds}: corpus={n_corpus} queries={n_queries} qrels_rows~={n_qrels} -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
