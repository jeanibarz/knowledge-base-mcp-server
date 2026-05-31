# Quality attributes — latency, memory, cost budgets

Current budgets and scale ceiling. All figures below come from RFC 007 §5 (the stubbed benchmark harness at `benchmarks/`); real-provider numbers will replace them in stage 0.2 of the RFC's rollout. Until then, treat wall-time numbers as structural (call counts and ratios) rather than as wall-clock promises.

If you are changing indexing, embeddings, or the request path, re-run `npm run bench` and diff the JSON output against the committed `benchmarks/results/` baseline.

## Latency budgets

| Phase                                                 | Today        | Source                       | Notes |
| ----------------------------------------------------- | ------------ | ---------------------------- | ----- |
| Constructor + module import (stub env)                | **170 ms**   | RFC 007 §5.1                 | Dominated by `@langchain/*` module load. No lazy imports today. |
| `initialize()` when a model index is absent           | **~2 ms**    | RFC 007 §5.1                 | Just creates the per-model dir and writes model metadata. |
| `initialize()` when loading existing index            | **not measured in-repo** | —                | RFC 007 §5.5 flags this as a deferred measurement; depends on index size + disk. |
| **Cold build**, 100 files × ~500 chunks, stubbed 20 ms/embedding | **10 761 ms**| RFC 007 §5.2                 | ~10 000 ms is the serial-embedding floor (500 × 20 ms); rest is 100 `save()` calls (now collapsed to 1 by PR #27). |
| **Warm no-op** (all hashes match), 100 files          | **84 ms p50** | RFC 007 §5.3                | Fixed floor from async-loop + per-file sha + sidecar read. |
| **Warm no-op**, 500 files                             | **84 ms p50** | RFC 007 §5.3                | Floor still dominates; per-file cost ~167 µs. |
| **Warm no-op**, 2 000 files                           | **87 ms p50** | RFC 007 §5.3                | Per-file cost drops to 44 µs; fixed floor still dominates. |
| `similaritySearch` (stubbed FAISS, k=10)              | **0.26 ms**  | RFC 007 §5.4                 | FAISS itself is not the bottleneck; the query-vector embedding round-trip is (not stubbed out). |

**Interpretation.** The request-path cost on a warm index is dominated by the
mandatory `updateIndex()` scan in the MCP `retrieve_knowledge` path, not by
FAISS search. That is the lever RFC 007 §6.3 / §7.5 is pulling. For now, budget
every `retrieve_knowledge` call at **80–100 ms warm + query-embedding RTT**;
cold builds are proportional to `total_chunks × per_chunk_embedding_latency`.

## Memory budgets

| Condition                         | Peak RSS   | Source         |
| --------------------------------- | ---------- | -------------- |
| After `new KnowledgeBaseServer()` | ~81 MB     | RFC 007 §5.1   |
| After cold build of 100 files     | ~112 MB    | RFC 007 §5.2 (Δ ≈ 31 MB) |
| After much larger KBs             | grows linearly with total chunks in the loaded model. Each model has its own FAISS store, and each store still contains every KB's vectors for that model. |

## Cost budgets (embedding-provider calls)

Today's embedding call pattern, per `updateIndex` call:

| Scenario                           | `embedDocuments` calls | Batched? |
| ---------------------------------- | ---------------------: | -------- |
| Warm no-op                         | 0                       | N/A      |
| 1 changed file                     | 1                       | Yes — its chunks fit in one bounded batch by default. |
| N changed files                    | `ceil(total_chunks / INDEXING_BATCH_SIZE)` | Yes — changed-file chunks are queued and embedded in bounded FAISS batches. |
| Fallback rebuild                   | `ceil(total_chunks / INDEXING_BATCH_SIZE)` | Yes — fallback rebuild uses the same bounded batching path. |

**Provider-rate implication.** A user with 100 modified files now pays for batches of chunks rather than one provider round trip per file. The default HuggingFace/OpenAI batch size is 64 chunks; the Ollama default is 16 chunks to keep local-provider payloads conservative.

## Supported scale

Current ceiling (informal, from code + §5 measurements, **not** a tested guarantee):

| Dimension                    | Ceiling                                           |
| ---------------------------- | ------------------------------------------------- |
| Number of files              | **Thousands.** Warm scan stays sub-100 ms up to ~2 000 (§5.3); beyond that, per-file sha256 cost starts to dominate. |
| Number of knowledge bases    | **Tens**, informally. No hard cap in code; per-model FAISS store memory is the practical limit. |
| Index size on disk           | **Tens of MB.** Larger is fine on modern disks; the not-yet-measured risk is `FaissStore.load` time at startup (RFC 007 §5.5). |
| Concurrent server processes  | Multiple MCP/CLI processes may share a `$FAISS_INDEX_PATH`; writes serialize through per-model locks and versioned atomic saves. |

## Known cliffs

- **Per-query scan.** Every MCP `retrieve_knowledge` call pays the warm scan
  floor even when nothing changed. RFC 007 §6.3 (scan-on-signal) and §7.5
  (mtime+size short-circuit) are the two candidate fixes.
- **Embedding provider payload limits.** `INDEXING_BATCH_SIZE` bounds changed-file and fallback rebuild batches. Raise it cautiously for high-throughput remote providers; lower it when a provider rejects large payloads.
- **Per-model global FAISS store memory.** Querying one KB still loads vectors
  from every KB for the selected model into RAM. The multi-model layout isolates
  models, not KBs.
- **Concurrent writers wait on locks.** Per-model write locks and versioned
  atomic saves protect index data. Very long writes can still delay refreshes for
  the same model.

## How to re-measure

```bash
npm install
npm run bench                          # stub provider; writes benchmarks/results/*.json
BENCH_PROVIDER=ollama npm run bench    # real provider (requires daemon)
BENCH_PROVIDER=openai npm run bench    # real provider (requires OPENAI_API_KEY)
```

Baselines in `benchmarks/results/` are keyed by `{provider}-{node_version}-{os}-{arch}`; compare apples to apples.

## CI regression summary

The benchmark workflow runs the stub provider on pull requests and appends a budget diff to the GitHub job summary. The diff compares the current `ci-{provider}-{node}-{os}-{arch}.json` report against the matching committed `baseline-{provider}-{node}-{os}-{arch}.json` report.

Rows are advisory by default. A manual `workflow_dispatch` run can enable `enforce_budgets`; that sets `BENCH_BUDGET_FAIL=1` and makes FAIL rows fail the job without rewriting the workflow.

| Metric | WARN threshold | FAIL threshold |
| ------ | -------------- | -------------- |
| Cold index wall time | >= 10% and >= 1,000 ms slower | >= 20% and >= 2,000 ms slower |
| Warm query p50/p95 | >= 10% and >= 10 ms slower | >= 25% and >= 25 ms slower |
| Warm query p99 | >= 10% and >= 15 ms slower | >= 25% and >= 30 ms slower |
| Peak RSS | >= 10% and >= 16 MiB higher | >= 25% and >= 32 MiB higher |
| Index storage total | >= 5% and >= 1 MiB higher | >= 15% and >= 5 MiB higher |
| Index bytes/vector | >= 5% and >= 16 B higher | >= 15% and >= 48 B higher |
| Batch throughput p50 | >= 10% lower | >= 20% lower |
| Retrieval recall@10 | >= 0.010 lower | >= 0.030 lower |

Optional scenarios such as batch throughput and storage are marked SKIP when either the current report or the committed baseline lacks that metric. They start producing deltas as soon as both sides contain the same JSON keys.

To update a baseline intentionally:

```bash
BENCH_PROVIDER=stub BENCH_RESULTS_PREFIX=baseline npm run bench
git diff -- benchmarks/results/
```

Commit the changed baseline with the code change that justifies the new budget. Do not refresh baselines to hide unrelated regressions; include the job-summary diff in the PR discussion when a threshold moves.

## Runtime budget enforcement (issue #210)

The bench harness above measures budgets offline. **At runtime**, the same wall-clock numbers are surfaced live in `kb_stats.provider_calls` (per-`model_id` count, errors, p50/p95/p99 latency, token-in sum) and rolled up in `kb doctor`'s `provider_calls` check. The doctor flips the row to `WARN` when `errors / count > 5%` for any active model_id, so an operator can observe both:

- a regression against the latency budgets above (compare live `provider_calls.<model_id>.latency_ms.p95` to the bench baseline);
- a sudden error-rate spike from the embedding provider (network blip, expired token, model decommission).

The histogram is bounded — 10 log-spaced latency buckets in [1 ms, 30 s] plus an overflow bucket — and labelled only by `model_id`, so memory cost stays at ~200 bytes per model in the registered set. No on-disk state, no per-query labels. `KB_METRICS_EXPORT=on` can additionally expose the bounded live counters through the authenticated `/metrics` endpoint documented in `docs/operations/metrics-export.md`.
