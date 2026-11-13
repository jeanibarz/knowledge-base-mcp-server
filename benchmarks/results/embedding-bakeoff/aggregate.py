#!/usr/bin/env python3
"""Aggregate #1047 embedding bake-off runs into summary.json.

Reads the committed per-run BEIR reports under ./runs/<model-slug>/ (written by
`benchmarks/beir/run.js --mode=dense`), the on-disk index sizes recorded by the
wrapper (./index-sizes.jsonl) and the controlled speed probe (./speed-microbench.json).
Prints a markdown table and writes ./summary.json. Never invents a value: a
missing cell is null / "ERR".

Usage: python3 -I aggregate.py <results_dir>
"""
import glob
import json
import os
import sys

DATASETS = ["scifact", "nfcorpus", "arguana"]

# Output dimension of each model, read from one Ollama /api/embed call per model
# on 2026-11-12 (the bake-off host). The FAISS index here is a flat float32
# index, so its file is chunks x dim x 4 bytes plus a ~45-byte header — checked
# against the measured faiss.index files in index-sizes.jsonl.
DIMS = {
    "dengcao/Qwen3-Embedding-0.6B:Q8_0": 1024,
    "nomic-embed-text": 768,
    "embeddinggemma": 768,
    "mxbai-embed-large": 1024,
    "granite-embedding:278m": 768,
    "nomic-embed-text-v2-moe": 768,
    "snowflake-arctic-embed2": 1024,
    "bge-m3": 1024,
}


def main():
    root = sys.argv[1]
    sizes = {}
    sizes_path = os.path.join(root, "index-sizes.jsonl")
    if os.path.exists(sizes_path):
        for line in open(sizes_path):
            row = json.loads(line)
            sizes[(row["model"], row["dataset"])] = row
    speed = {}
    speed_path = os.path.join(root, "speed-microbench.json")
    if os.path.exists(speed_path):
        speed = json.load(open(speed_path))["summary"]

    models = {}
    for path in sorted(glob.glob(os.path.join(root, "runs", "*", "kb-*-dense-chunk-results.json"))):
        rep = json.load(open(path))
        model = rep["embedding"]["model"]
        ds = rep["dataset"]["name"]
        entry = models.setdefault(model, {"datasets": {}})
        idx_s = rep["indexing"]["ms"] / 1000
        size = sizes.get((model, ds), {})
        entry["datasets"][ds] = {
            "ndcg10": rep["metrics"]["ndcgAt10"],
            "recall100": rep["metrics"]["recallAt100"],
            "queries": rep["dataset"]["queries_evaluated"],
            "docs": rep["dataset"]["corpus_documents"],
            "chunks": rep["indexing"]["chunks"],
            "index_s": round(idx_s, 1),
            "chunks_per_s": round(rep["indexing"]["chunks"] / idx_s, 2) if idx_s > 0 else None,
            "query_p50_ms": rep["latency"]["p50Ms"],
            "query_p95_ms": rep["latency"]["p95Ms"],
            "index_bytes_measured": size.get("faiss_index_bytes"),
            "index_bytes_flat_f32": rep["indexing"]["chunks"] * DIMS[model] * 4 if model in DIMS else None,
            "index_dir_bytes": size.get("model_dir_bytes"),
            "git_sha": rep["git_sha"],
            "report": os.path.relpath(path, root),
        }
    # Models that only ran the speed probe (quality run cut for time) still get a row.
    for model in speed:
        models.setdefault(model, {"datasets": {}})
    out = {}
    for model, entry in models.items():
        dsets = entry["datasets"]
        complete = all(d in dsets for d in DATASETS)
        nd = [dsets[d]["ndcg10"] for d in DATASETS if d in dsets]
        total_chunks = sum(dsets[d]["chunks"] for d in dsets)
        total_s = sum(dsets[d]["index_s"] for d in dsets)
        out[model] = {
            "datasets": dsets,
            "complete": complete,
            "mean_ndcg10": round(sum(nd) / len(nd), 4) if complete else None,
            "mean_ndcg10_scifact_nfcorpus": (
                round((dsets["scifact"]["ndcg10"] + dsets["nfcorpus"]["ndcg10"]) / 2, 4)
                if "scifact" in dsets and "nfcorpus" in dsets else None
            ),
            "observed_chunks_per_s": round(total_chunks / total_s, 1) if total_s else None,
            "dim": DIMS.get(model),
            "index_bytes_flat_f32_total": sum(dsets[d]["index_bytes_flat_f32"] or 0 for d in dsets) or None,
            "speed_microbench": speed.get(model),
        }
    json.dump(out, open(os.path.join(root, "summary.json"), "w"), indent=2, sort_keys=True)

    head = "| model | " + " | ".join(DATASETS) + " | mean sf+nf | mean (3 sets) | observed chunks/s | probe chunks/s | probe query p50 / p95 ms | dim | index MB (NFCorpus) |"
    print(head)
    print("|" + " --- |" * (len(DATASETS) + 8))
    for model, row in sorted(out.items(), key=lambda kv: -(kv[1]["datasets"].get("nfcorpus", {}).get("ndcg10") or 0)):
        cells = []
        for d in DATASETS:
            cells.append(f"{row['datasets'][d]['ndcg10']:.4f}" if d in row["datasets"] else "not run")
        sp = row["speed_microbench"] or {}
        mean = f"{row['mean_ndcg10']:.4f}" if row["mean_ndcg10"] is not None else "n/a"
        m2 = row["mean_ndcg10_scifact_nfcorpus"]
        mean = (f"{m2:.4f}" if m2 is not None else "n/a") + " | " + mean
        probe_cps = f"{sp['chunks_per_s_median']:.1f}" if "chunks_per_s_median" in sp else "n/a"
        probe_q = (f"{sp['query_p50_ms_median']:.0f} / {sp['query_p95_ms_median']:.0f}"
                   if "query_p50_ms_median" in sp else "n/a")
        nf = row["datasets"].get("nfcorpus")
        mb = f"{nf['index_bytes_flat_f32'] / 1e6:.1f}" if nf and nf.get("index_bytes_flat_f32") else "n/a"
        print(f"| `{model}` | " + " | ".join(cells) +
              f" | {mean} | {row['observed_chunks_per_s'] or 'n/a'} | {probe_cps} | {probe_q} | {row['dim']} | {mb} |")


if __name__ == "__main__":
    main()
