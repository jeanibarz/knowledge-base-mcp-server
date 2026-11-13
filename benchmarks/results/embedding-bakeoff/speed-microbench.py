#!/usr/bin/env python3
"""Controlled embedding speed micro-benchmark for the #1047 bake-off.

Why a separate speed probe: the BEIR runner's index wall time is the honest
end-to-end number, but on a GPU shared with other live Ollama workloads it
swings with whatever else is running. This probe sends the *same* inputs to
every model, serially, in round-robin rounds, so per-model numbers see the same
background load as closely as a shared host allows. Report the median over
rounds.

Inputs mirror what the server sends:
  - documents: SciFact corpus text cut into 1000-char windows with 200-char
    overlap (the default KB_CHUNK_SIZE / KB_CHUNK_OVERLAP), batched 16 per
    /api/embed call (DEFAULT_OLLAMA_INDEXING_BATCH_SIZE in src/config/indexing.ts);
  - queries: real SciFact test queries, one /api/embed call each (the query path);
  - the nomic-embed-text family gets the server's `search_document: ` /
    `search_query: ` prefixes (src/embedding-provider.ts); no other model gets a
    prefix, matching the server.

Usage: python3 -I speed-microbench.py <scifact_dir> <out.json> <rounds> <model> [<model> ...]
"""
import json
import statistics
import sys
import time
import urllib.request

OLLAMA = "http://localhost:11434/api/embed"
N_CHUNKS = 256
BATCH = 16
N_QUERIES = 60


def embed(model, inputs):
    body = json.dumps({"model": model, "input": inputs, "keep_alive": "2m"}).encode()
    req = urllib.request.Request(OLLAMA, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as resp:
        data = json.loads(resp.read())
    if "embeddings" not in data:
        raise RuntimeError(f"{model}: {data}")
    return data["embeddings"]


def prefixes(model):
    if "nomic-embed-text" in model:
        return "search_query: ", "search_document: "
    return "", ""


def load_inputs(scifact_dir):
    chunks = []
    with open(f"{scifact_dir}/corpus.jsonl") as fh:
        for line in fh:
            row = json.loads(line)
            text = (row.get("title", "") + "\n\n" + row.get("text", "")).strip()
            start = 0
            while start < len(text) and len(chunks) < N_CHUNKS:
                chunks.append(text[start:start + 1000])
                if start + 1000 >= len(text):
                    break
                start += 800
            if len(chunks) >= N_CHUNKS:
                break
    judged = set()
    with open(f"{scifact_dir}/qrels/test.tsv") as fh:
        next(fh)
        for line in fh:
            judged.add(line.split("\t")[0])
    queries = []
    with open(f"{scifact_dir}/queries.jsonl") as fh:
        for line in fh:
            row = json.loads(line)
            if row["_id"] in judged:
                queries.append(row["text"])
            if len(queries) >= N_QUERIES:
                break
    return chunks, queries


def pct(values, q):
    s = sorted(values)
    idx = min(len(s) - 1, max(0, round(q * (len(s) - 1))))
    return s[idx]


def one_round(model, chunks, queries):
    qp, dp = prefixes(model)
    embed(model, [dp + "warmup"])  # load/warm the model outside the timed region
    t0 = time.perf_counter()
    dim = None
    for i in range(0, len(chunks), BATCH):
        out = embed(model, [dp + c for c in chunks[i:i + BATCH]])
        dim = len(out[0])
    doc_s = time.perf_counter() - t0
    lat = []
    for q in queries:
        t = time.perf_counter()
        embed(model, [qp + q])
        lat.append((time.perf_counter() - t) * 1000)
    return {
        "chunks_per_s": len(chunks) / doc_s,
        "query_p50_ms": pct(lat, 0.5),
        "query_p95_ms": pct(lat, 0.95),
        "dim": dim,
    }


def main():
    scifact_dir, out_path, rounds = sys.argv[1], sys.argv[2], int(sys.argv[3])
    models = sys.argv[4:]
    chunks, queries = load_inputs(scifact_dir)
    per_model = {m: [] for m in models}
    for r in range(rounds):
        for m in models:
            try:
                res = one_round(m, chunks, queries)
            except Exception as exc:  # record, never fabricate
                res = {"error": str(exc)}
            res["round"] = r
            res["at"] = time.strftime("%H:%M:%S")
            per_model[m].append(res)
            print(json.dumps({"model": m, **res}), flush=True)
    summary = {}
    for m, rows in per_model.items():
        ok = [x for x in rows if "error" not in x]
        if not ok:
            summary[m] = {"error": rows[-1].get("error")}
            continue
        summary[m] = {
            "dim": ok[0]["dim"],
            "rounds_ok": len(ok),
            "chunks_per_s_median": statistics.median(x["chunks_per_s"] for x in ok),
            "query_p50_ms_median": statistics.median(x["query_p50_ms"] for x in ok),
            "query_p95_ms_median": statistics.median(x["query_p95_ms"] for x in ok),
        }
    with open(out_path, "w") as fh:
        json.dump({
            "schema": "kb.embedding-bakeoff.speed-microbench.v1",
            "n_chunks": len(chunks), "batch": BATCH, "n_queries": len(queries), "rounds": rounds,
            "summary": summary, "raw": per_model,
        }, fh, indent=2)


if __name__ == "__main__":
    main()
