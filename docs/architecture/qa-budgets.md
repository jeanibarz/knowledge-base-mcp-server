# Quality attributes — latency, memory, cost budgets

Current budgets and scale ceiling. All figures below come from RFC 007 §5 (the stubbed benchmark harness at `benchmarks/`); real-provider numbers will replace them in stage 0.2 of the RFC's rollout. Until then, treat wall-time numbers as structural (call counts and ratios) rather than as wall-clock promises.

If you are changing indexing, embeddings, or the request path, re-run `npm run bench` and diff the JSON output against the committed `benchmarks/results/` baseline.

## Latency budgets

| Phase                                                 | Today        | Source                       | Notes |
| ----------------------------------------------------- | ------------ | ---------------------------- | ----- |
| Constructor + module import (stub env)                | **170 ms**   | RFC 007 §5.1                 | Dominated by `@langchain/*` module load. No lazy imports today. |
| `initialize()` when `faiss.index` is absent           | **~2 ms**    | RFC 007 §5.1                 | Just creates the dir and writes `model_name.txt`. |
| `initialize()` when loading existing index            | **not measured in-repo** | —                | RFC 007 §5.5 flags this as a deferred measurement; depends on index size + disk. |
| **Cold build**, 100 files × ~500 chunks, stubbed 20 ms/embedding | **10 761 ms**| RFC 007 §5.2                 | ~10 000 ms is the serial-embedding floor (500 × 20 ms); rest is 100 `save()` calls (now collapsed to 1 by PR #27). |
| **Warm no-op** (all hashes match), 100 files          | **84 ms p50** | RFC 007 §5.3                | Fixed floor from async-loop + per-file sha + sidecar read. |
| **Warm no-op**, 500 files                             | **84 ms p50** | RFC 007 §5.3                | Floor still dominates; per-file cost ~167 µs. |
| **Warm no-op**, 2 000 files                           | **87 ms p50** | RFC 007 §5.3                | Per-file cost drops to 44 µs; fixed floor still dominates. |
| `similaritySearch` (stubbed FAISS, k=10)              | **0.26 ms**  | RFC 007 §5.4                 | FAISS itself is not the bottleneck; the query-vector embedding round-trip is (not stubbed out). |

**Interpretation.** The request-path cost on a warm index is dominated by the mandatory `updateIndex()` scan at `src/KnowledgeBaseServer.ts:84`, not by FAISS search. That is the lever RFC 007 §6.3 / §7.5 is pulling. For now, budget every `retrieve_knowledge` call at **80–100 ms warm + query-embedding RTT**; cold builds are proportional to `total_chunks × per_chunk_embedding_latency`.

## Memory budgets

| Condition                         | Peak RSS   | Source         |
| --------------------------------- | ---------- | -------------- |
| After `new KnowledgeBaseServer()` | ~81 MB     | RFC 007 §5.1   |
| After cold build of 100 files     | ~112 MB    | RFC 007 §5.2 (Δ ≈ 31 MB) |
| After much larger KBs             | grows linearly with total chunks — **single global FAISS store** holds every KB's vectors today (`src/FaissIndexManager.ts:81`). RFC 007 §6.4 plans per-KB isolation + bounded LRU. |

## Cost budgets (embedding-provider calls)

Today's embedding call pattern, per `updateIndex` call:

| Scenario                           | `embedDocuments` calls | Batched? |
| ---------------------------------- | ---------------------: | -------- |
| Warm no-op                         | 0                       | N/A      |
| 1 changed file                     | 1                       | Yes (one call per file, carrying that file's chunks) |
| N changed files                    | N                       | **No** — each file goes through `addDocuments`/`fromTexts` serially at `src/FaissIndexManager.ts:278-287`. RFC 007 §6.2 batches this. |
| Fallback rebuild                   | 1                       | Yes — one call with every chunk at `:338-343` |

**Provider-rate implication.** A user with 100 modified files on HuggingFace (~100 ms/call) pays 10 s minimum regardless of chunk count per file — because the calls are sequential. The fallback-rebuild path is faster per chunk than the changed-file path because it packs everything into one call.

## Supported scale

Current ceiling (informal, from code + §5 measurements, **not** a tested guarantee):

| Dimension                    | Ceiling                                           |
| ---------------------------- | ------------------------------------------------- |
| Number of files              | **Thousands.** Warm scan stays sub-100 ms up to ~2 000 (§5.3); beyond that, per-file sha256 cost starts to dominate. |
| Number of knowledge bases    | **Tens**, informally. No hard cap in code; a global FAISS store means memory is the practical limit. |
| Index size on disk           | **Tens of MB.** Larger is fine on modern disks; the not-yet-measured risk is `FaissStore.load` time at startup (RFC 007 §5.5). |
| Concurrent server processes  | **1 per `$FAISS_INDEX_PATH`.** See [`threat-model.md`](./threat-model.md#concurrency) — multiple processes race on `save()` and sidecar tmp+rename, and will corrupt state. |

## Known cliffs

- **Per-query scan** (`src/KnowledgeBaseServer.ts:84` → `src/FaissIndexManager.ts:202-389`). Every `retrieve_knowledge` pays the ~85 ms scan floor even when nothing changed. RFC 007 §6.3 (scan-on-signal) and §7.5 (mtime+size short-circuit) are the two candidate fixes.
- **Per-file embedding round-trip** (`src/FaissIndexManager.ts:278-287`). Changed-file calls are serial, not batched. RFC 007 §6.2 tracks the batch refactor.
- **Global FAISS store memory** (`src/FaissIndexManager.ts:81`). Querying one KB still loads vectors from every KB into RAM. RFC 007 §6.4 tracks the per-KB split.
- **No concurrency guard** across processes. One process per `$FAISS_INDEX_PATH` is a documented constraint, not an enforced one — see [`threat-model.md`](./threat-model.md) and issue #44.

## How to re-measure

```bash
npm install
npm run bench                          # stub provider; writes benchmarks/results/*.json
BENCH_PROVIDER=ollama npm run bench    # real provider (requires daemon)
BENCH_PROVIDER=openai npm run bench    # real provider (requires OPENAI_API_KEY)
```

Baselines in `benchmarks/results/` are keyed by `{provider}-{node_version}-{os}-{arch}`; compare apples to apples.
