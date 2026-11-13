#!/usr/bin/env python3
"""Aggregate #1049 reranker bake-off runs into summary.json + a markdown table.

Reads ./runs/<dataset>/<variant>/kb-<dataset>-<mode>-chunk-results.json written by
sweep-rerankers.mjs. For every rerank variant it reports nDCG@10, the delta over
plain hybrid on the same query set, and the added p50/p95 query latency
(variant p50 - hybrid p50; both include the query embed because the sweep runs
with KB_QUERY_CACHE=off). Also runs two sanity checks that would expose a
silently-degraded reranker (src/reranker.ts fails open to fused order):
  - identical_to_hybrid: per-query nDCG@10 vector equal to hybrid's;
  - recall100_matches_hybrid: rerank only reorders the top-N, so Recall@100
    must equal hybrid's.
Never invents a value: a missing cell is null / "ERR".

A third, partial-degradation check needs the TREC run files (not committed —
pass the raw output dir as the second argument): `top10_identical_queries`
counts queries whose top-10 document order equals hybrid's. A reranker that
failed open for a stretch of queries (e.g. a CUDA OOM on load, retried per
query) shows up as a large count there even when the nDCG differs overall.

Usage: python3 -I aggregate.py <results_dir> [<raw_out_dir_with_trec>]
"""
import glob
import json
import os
import sys

DATASETS = ["scifact", "nfcorpus", "arguana"]
VARIANTS = ["minilm-l6", "mxbai-xsmall-v1", "jina-v1-turbo-en", "bge-base", "mxbai-base-v1", "bge-v2-m3-fp16"]


def load(root, ds, variant):
    paths = glob.glob(os.path.join(root, "runs", ds, variant, "kb-*-results.json"))
    return json.load(open(paths[0])) if paths else None


def top10(trec_path):
    runs = {}
    for line in open(trec_path):
        parts = line.split()
        if len(parts) < 6:
            continue
        qid, _, doc, rank = parts[0], parts[1], parts[2], int(parts[3])
        if rank <= 10:
            runs.setdefault(qid, []).append((rank, doc))
    return {q: [d for _, d in sorted(v)] for q, v in runs.items()}


def trec_for(raw, ds, variant):
    paths = glob.glob(os.path.join(raw, ds, variant, "kb-*-run.trec")) if raw else []
    return top10(paths[0]) if paths else None


def main():
    root = sys.argv[1]
    raw = sys.argv[2] if len(sys.argv) > 2 else None
    out = {"datasets": {}, "variants": {}}
    for ds in DATASETS:
        hyb = load(root, ds, "hybrid")
        if hyb is None:
            continue
        hq = {r["queryId"]: r["ndcgAt10"] for r in hyb["per_query"]}
        htrec = trec_for(raw, ds, "hybrid")
        out["datasets"][ds] = {
            "hybrid_ndcg10": hyb["metrics"]["ndcgAt10"],
            "hybrid_p50_ms": hyb["latency"]["p50Ms"],
            "hybrid_p95_ms": hyb["latency"]["p95Ms"],
            "queries": hyb["dataset"]["queries_evaluated"],
            "queries_total_judged": hyb["dataset"]["qrels_queries"],
        }
        for v in VARIANTS:
            rep = load(root, ds, v)
            cell = out["variants"].setdefault(v, {"datasets": {}})
            if rep is None:
                cell["datasets"][ds] = None
                continue
            cell["model"] = rep["rerank"]["model"]
            vq = {r["queryId"]: r["ndcgAt10"] for r in rep["per_query"]}
            cell["datasets"][ds] = {
                "ndcg10": rep["metrics"]["ndcgAt10"],
                "delta_vs_hybrid": round(rep["metrics"]["ndcgAt10"] - hyb["metrics"]["ndcgAt10"], 5),
                "p50_ms": rep["latency"]["p50Ms"],
                "p95_ms": rep["latency"]["p95Ms"],
                "added_p50_ms": round(rep["latency"]["p50Ms"] - hyb["latency"]["p50Ms"], 1),
                "added_p95_ms": round(rep["latency"]["p95Ms"] - hyb["latency"]["p95Ms"], 1),
                "identical_to_hybrid": vq == hq,
                "recall100_matches_hybrid": abs(rep["metrics"]["recallAt100"] - hyb["metrics"]["recallAt100"]) < 1e-9,
                "rerank_enabled": rep["rerank"]["enabled"],
                "topN": rep["rerank"]["topN"],
            }
            vtrec = trec_for(raw, ds, v)
            if htrec is not None and vtrec is not None:
                cell["datasets"][ds]["top10_identical_queries"] = sum(
                    1 for q, docs in vtrec.items() if htrec.get(q) == docs
                )
    # A cell where >=10% of queries kept hybrid's exact top-10 order is treated
    # as a partial fail-open (blend of hybrid and rerank): marked invalid and
    # left out of means and significance.
    for v, cell in out["variants"].items():
        for d, c in cell["datasets"].items():
            if c is not None:
                same = c.get("top10_identical_queries")
                c["valid"] = not c["identical_to_hybrid"] and (same is None or same < 0.1 * out["datasets"][d]["queries"])
    for v, cell in out["variants"].items():
        cells = [cell["datasets"].get(d) for d in DATASETS]
        cells = [c if c is not None and c["valid"] else None for c in cells]
        if all(c is not None for c in cells):
            cell["mean_ndcg10"] = round(sum(c["ndcg10"] for c in cells) / 3, 4)
            cell["mean_delta"] = round(sum(c["delta_vs_hybrid"] for c in cells) / 3, 4)
            cell["mean_added_p50_ms"] = round(sum(c["added_p50_ms"] for c in cells) / 3, 1)
            cell["mean_added_p95_ms"] = round(sum(c["added_p95_ms"] for c in cells) / 3, 1)
    # Isolated rerank-stage latency (rerank-latency-probe.mjs), per dataset.
    probe = {}
    for ds in DATASETS:
        pth = os.path.join(root, f"rerank-latency-{ds}.json")
        if os.path.exists(pth):
            for v, r in json.load(open(pth))["results"].items():
                probe.setdefault(v, {})[ds] = r
    for v, cell in out["variants"].items():
        cell["latency_probe"] = probe.get(v, {})
    json.dump(out, open(os.path.join(root, "summary.json"), "w"), indent=2, sort_keys=True)

    hy = [out["datasets"].get(d) for d in DATASETS]
    print("| variant | " + " | ".join(f"{d} nDCG@10 (Δ)" for d in DATASETS) +
          " | mean nDCG@10 | mean Δ | rerank-stage p50 ms (sf / nf / ag) | rerank-stage p95 ms (sf / nf / ag) |")
    print("|" + " --- |" * (len(DATASETS) + 5))
    hcells = [f"{c['hybrid_ndcg10']:.4f}" if c else "ERR" for c in hy]
    hmean = sum(c["hybrid_ndcg10"] for c in hy) / 3 if all(hy) else None
    print("| hybrid (no rerank) | " + " | ".join(hcells) + f" | {hmean:.4f} | — | — | — |" if hmean else "| hybrid | ERR |")
    for v in VARIANTS:
        cell = out["variants"].get(v)
        if cell is None:
            continue
        cs = [cell["datasets"].get(d) for d in DATASETS]
        txt = [
            ("invalid (fail-open)" if not c["valid"] else f"{c['ndcg10']:.4f} ({c['delta_vs_hybrid']:+.4f})")
            if c else "not run" for c in cs
        ]
        pr = cell.get("latency_probe", {})
        def lat(ds, key):
            r = pr.get(ds)
            return f"{r[key]:.0f}" if r and key in r else "n/a"
        p50 = " / ".join(lat(d, "p50_ms") for d in DATASETS)
        p95 = " / ".join(lat(d, "p95_ms") for d in DATASETS)
        mean = f"{cell['mean_ndcg10']:.4f}" if "mean_ndcg10" in cell else "n/a"
        md = f"{cell['mean_delta']:+.4f}" if "mean_delta" in cell else "n/a"
        print(f"| `{v}` | " + " | ".join(txt) + f" | {mean} | {md} | {p50} | {p95} |")


if __name__ == "__main__":
    main()
