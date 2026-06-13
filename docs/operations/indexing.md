# Indexing Operations

## Embedding Batch Concurrency

`KB_INDEXING_CONCURRENCY` controls how many indexing embedding batches may be
in flight at once. It defaults to `1`, which preserves the historical serial
behavior.

When set above `1`, indexing overlaps provider calls for later batches while
FAISS insertion remains serialized in batch order. Progress events are emitted
only after each in-order insert, so `batchIndex` and `processedChunks` remain
monotonic even if a later embedding request completes first.

The value is capped at `4` to bound memory to a small number of vector batches.
Remote providers such as `huggingface` and `openai` may use the requested value.
For `ollama`, values above `1` are ignored unless `OLLAMA_NUM_PARALLEL` is also
set above `1`; the effective concurrency is then capped by `OLLAMA_NUM_PARALLEL`.

Example:

```bash
KB_INDEXING_CONCURRENCY=4 kb reindex
```

Cross-batch duplicate chunks may be embedded more than once when their batches
are in flight at the same time. Duplicate compaction still works within each
embedding call and for already-completed batches. This tradeoff keeps the
pipeline bounded and avoids retaining unbounded pending duplicate state during
large reindexes.

Use the local measurement harness before changing production defaults:

```bash
node benchmarks/indexing-concurrency.mjs
KB_INDEXING_CONCURRENCY=2 node benchmarks/indexing-concurrency.mjs
```

The harness simulates provider latency and serialized insertion. Real-provider
throughput still depends on provider rate limits, local Ollama parallelism, and
network latency.

## HNSW ANN Indexing

`KB_INDEX_TYPE=hnsw` enables the dedicated `hnswlib-node` backend. It is
opt-in only; `flat` remains the default, and the server does not auto-enable
approximate search based on corpus size or latency.

Use HNSW when a large local corpus has measured dense-search latency that is
too high for the workflow and a recall trade-off is acceptable. HNSW changes
retrieval semantics: it is approximate nearest-neighbor search, so top-k
results can differ from exact flat search. Raise `KB_HNSW_EF_SEARCH` to recover
recall at query time, and raise `KB_HNSW_EF_CONSTRUCTION` when rebuild time and
graph memory are acceptable.

```bash
KB_INDEX_TYPE=hnsw \
KB_HNSW_M=32 \
KB_HNSW_EF_CONSTRUCTION=200 \
KB_HNSW_EF_SEARCH=100 \
kb reindex --force
```

Parameter mapping:

- `KB_HNSW_M` maps to `HierarchicalNSW.initIndex(..., m, ...)`.
- `KB_HNSW_EF_CONSTRUCTION` maps to `initIndex(..., efConstruction, ...)`.
- `KB_HNSW_EF_SEARCH` maps to `setEf(ef)` and is reapplied after every load and
  before query execution.

HNSW indexes use the same versioned swap model as FAISS but persist a distinct
binary:

```text
$FAISS_INDEX_PATH/models/<model_id>/
  index -> index.vN
  index.vN/
    hnsw.index
    docstore.json
    integrity.json
```

The integrity manifest records `backend: "hnsw"`, `index_type: "hnsw"`, `m`,
`efConstruction`, `efSearch`, metric, capacity policy, random seed, dimensions,
and file hashes. A backend or build-parameter mismatch removes the active
symlink for rebuild, or fails in strict read-only mode; it is not loaded as the
wrong binary format. Existing `flat` and `sq8` FAISS indexes continue to use
`faiss.index` and the legacy FAISS load path.

Benchmark before recommending HNSW for an installation:

```bash
node benchmarks/hnsw-ann.mjs
```

The harness reports recall@k and nDCG@k deltas against exact flat search,
p50/p95 query latency, HNSW memory delta, and bootstrap confidence intervals
for flat, SQ8, and HNSW. A local smoke run on 2026-06-13 used:

```bash
KB_HNSW_BENCH_VECTORS=500 \
KB_HNSW_BENCH_QUERIES=30 \
KB_HNSW_BENCH_BOOTSTRAP=50 \
node benchmarks/hnsw-ann.mjs
```

Smoke result summary: HNSW recall@10 `1.0` with CI `[1.0, 1.0]`, nDCG@10
`1.0` with CI `[1.0, 1.0]`, p50 `0.0349ms`, p95 `0.0519ms`, and about `3.0MiB`
RSS delta. This is a synthetic smoke check only; use the BEIR/evaluation
fixtures for corpus-specific promotion decisions.
