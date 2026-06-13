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
