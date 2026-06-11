# Late-Interaction Retrieval Evaluation (#578)

Generated: 2026-06-09

## Scope

This note records the design choice and evaluation status for the experimental
late-interaction retrieval tier added for #578. It does not change production
search defaults and does not fabricate benchmark numbers.

## Design Options Compared

### ColBERTv2 / PLAID External Index

- Best fit for a production late-interaction tier: trained token embeddings,
  compressed residual vectors, ANN-style candidate traversal, and published
  evidence for quality/latency tradeoffs.
- Operational cost is highest: Python service, model/index lifecycle, GPU is
  strongly preferred for indexing, and the index format is separate from the
  current FAISS single-vector store.
- Recommendation for now: evaluate after the benchmark adapter proves a Pareto
  target that a real ColBERT backend must beat.

### Small Local Late-Interaction Sidecar

- Middle path: keep TypeScript search unchanged and call a local Python sidecar
  for token embeddings and MaxSim reranking.
- Easier to prototype with sentence-transformers or ColBERT libraries than a
  native TypeScript implementation, but adds service lifecycle and resource
  reporting requirements.
- Recommendation for now: viable next milestone if real BEIR results justify
  continuing.

### Rerank-Only Late Interaction Over Top-N Candidates

- Lowest-risk first milestone: keep BM25/dense/hybrid candidate generation as
  is, then reorder a bounded candidate set with token-level MaxSim.
- It tests whether token-level evidence helps before committing to a new
  production index.
- Implemented here as `hybrid+late`, alongside `late` standalone retrieval.

## Implemented

- `benchmarks/beir/late-interaction.ts`: benchmark-only ColBERT-style MaxSim
  adapter using hashed token and character-ngram vectors.
- `benchmarks/beir/run.ts` modes:
  - `late`: standalone credential-free MaxSim over BEIR document Markdown.
  - `hybrid+late`: production hybrid candidates, reranked by the benchmark-only
    MaxSim adapter.
- JSON/Markdown report field: `late_interaction`, recording model id, token
  dimensions, documents indexed, token vector count, estimated index size,
  build time, CPU/GPU requirements, and candidate source.
- Matrix/baseline mode parsing accepts `late` and `hybrid+late` without adding
  them to the default sweeps.

## Measured Smoke Results

These are fixture-plumbing numbers on
`benchmarks/beir/fixtures/gate/gate-fixture`, not semantic quality claims. The
fixture is intentionally small and deterministic.

| dataset | mode | provider | queries | nDCG@10 | MAP@100 | Recall@100 | p50 / p95 latency | index build | estimated late index |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| gate-fixture | `late` | none | 10 | 1.000000 | 1.000000 | 1.000000 | 0.515 / 2.163 ms | 5.394 ms | 112,640 bytes |
| gate-fixture | `hybrid+late` | fake | 10 | 1.000000 | 1.000000 | 1.000000 | 8.881 / 37.199 ms | 7.645 ms late, 226.859 ms total | 112,640 bytes |

Commands run:

```bash
npm run bench:beir -- --dataset=gate-fixture \
  --dataset-dir=benchmarks/beir/fixtures/gate/gate-fixture \
  --split=test --mode=late \
  --output-dir=/tmp/kb-beir-issue578-gate-late \
  --workspace-root=/tmp/kb-beir-issue578-gate-late-ws

npm run bench:beir -- --dataset=gate-fixture \
  --dataset-dir=benchmarks/beir/fixtures/gate/gate-fixture \
  --split=test --mode=hybrid+late --provider=fake \
  --output-dir=/tmp/kb-beir-issue578-gate-hybrid-late \
  --workspace-root=/tmp/kb-beir-issue578-gate-hybrid-late-ws
```

## Comparison Against #573 Baselines

Committed #573 SciFact baselines in
`benchmarks/results/beir/baseline/README.md`:

| dataset | mode | provider/model | nDCG@10 | MAP@100 | Recall@100 | p50 / p95 latency |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| SciFact | `lexical` | none | 0.668981 | 0.630274 | 0.895889 | 24.967 / 44.327 ms |
| SciFact | `dense` | ollama / nomic-embed-text | 0.491414 | 0.456433 | 0.808333 | 154.787 / 174.126 ms |
| SciFact | `hybrid` | ollama / nomic-embed-text | 0.610915 | 0.566212 | 0.921333 | 910.036 / 1043.893 ms |

Additional local artifact present at `/tmp/qwen3-smoke`:

| dataset | mode | provider/model | nDCG@10 | MAP@100 | Recall@100 | p50 / p95 latency |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| SciFact | `dense` | ollama / dengcao/Qwen3-Embedding-0.6B:Q8_0 | 0.641350 | 0.596610 | 0.918333 | 463.062 / 579.364 ms |

No committed #573 `hybrid+rerank` baseline artifact is present in this
worktree, so `hybrid+late vs hybrid+cross-encoder` remains pending.

## Blocked Real BEIR Run

Attempted:

```bash
npm run bench:beir -- --dataset=scifact --split=test --mode=late \
  --max-queries=10 \
  --output-dir=/tmp/kb-beir-issue578-scifact-late \
  --workspace-root=/tmp/kb-beir-issue578-late-ws
```

Result: failed during dataset download with `TypeError: fetch failed` from the
canonical BEIR UKP host. This matches the #573 note that the host can be
unreachable from this environment. The previous Hugging Face-converted
`/tmp/beir-hf/scifact` directory was not present.

## Required Sample Status

- SciFact: supported by the runner; live run blocked by dataset availability in
  this session.
- NFCorpus, FiQA, ArguAna, SciDocs: mode is wired and selectable; real runs
  pending dataset availability and, for `hybrid+late`, real embedding provider
  time.
- BRIGHT sample: not attempted; setup cost was not reasonable before a real
  BEIR late-interaction result exists.

## Recommendation

Keep this as a benchmark-only experiment and do not promote it to production.

The implemented path proves the benchmark surface and records the required
resource metadata, but the current hashed-vector adapter is not a trained
semantic late-interaction model. The next useful decision point is a real BEIR
run on SciFact plus at least NFCorpus/FiQA with either ColBERTv2/PLAID or a
small Python sidecar. Promote only if `hybrid+late` improves quality over
`hybrid` at materially lower latency than `hybrid+rerank`; otherwise abandon
standalone `late` and keep only a rerank-tier experiment.
