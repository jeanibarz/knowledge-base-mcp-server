# BEIR matrix — Qwen3 embeddings + **local qwen3-4b-instruct** contextual prefaces

Companion to `../qwen3/` (same embedding model, DeepSeek prefaces). This variant
regenerates the RFC 017 contextual prefaces with the **local** model
`qwen3:4b-instruct-2507-q4_K_M` (Ollama, GPU) instead of
`deepseek/deepseek-v4-flash` — matching the model now used to preface the
production KB.

## Why this directory exists

The `../qwen3/` (DeepSeek) matrix could only report `hybrid+rerank+contextual`
on **3/5** datasets: the DeepSeek preface caches for **fiqa (100% null)** and
**scidocs (32% null)** had silently failed during generation, so those two
contextual cells errored out. Regenerating with local qwen3-4b succeeded on all
five (fiqa 0.00% null, scidocs 0.05%), giving the first **complete 5/5**
contextual headline.

## Headline (5/5)

| Mode | mean nDCG@10 (5/5) |
| --- | ---: |
| dense | 0.3734 |
| hybrid | 0.3893 |
| hybrid+rerank | 0.3868 |
| **hybrid+rerank+contextual** | **0.3915** |

Contextual prefaces give a small, consistent lift over `hybrid+rerank`
(≥ on every dataset). Note the DeepSeek matrix's `0.4734` contextual number was
a **3/5** mean (scifact/nfcorpus/arguana only) and is not comparable to this
5/5 mean — including the hard fiqa/scidocs corpora is what lowers it.

## Provenance / how to reproduce

- **Embeddings:** `dengcao/Qwen3-Embedding-0.6B:Q8_0` (Ollama), RRF c=60,
  chunk 1000/200 — identical to `../qwen3/`.
- **Contextual prefaces:** `qwen3:4b-instruct-2507-q4_K_M` via Ollama, generated
  with `benchmarks/scripts/prefab_prefaces.mjs` (generator `contextual-preface.v1`),
  cached under `~/.cache/kb-beir-preface-cache-q4/<ds>-fip`.
- **Reranker:** `Xenova/ms-marco-MiniLM-L-6-v2`, topN=40, run on **GPU**
  (`KB_RERANK_DEVICE=cuda KB_RERANK_DTYPE=fp32`, onnxruntime CUDA EP). GPU-fp32
  rerank matches the CPU-quantized path to 4 decimals (verified on scifact /
  nfcorpus), so it is comparable to `../qwen3/`; it is ~60× faster on
  long-document cross-encoding.
- **Code:** built at commit `869d527` (generator v1, so the v1 preface caches
  validate) plus the opt-in GPU-rerank change to `src/reranker.ts`.
- **Non-contextual cells** (lexical/dense/hybrid/hybrid+rerank/late/hybrid+late)
  are copied from `../qwen3/` — they are preface-independent and identical.

> The generic header in `beir-matrix.md` prints `contextual=off` and does not
> note the GPU reranker — those fields come from the merge process env, not the
> per-cell runs. The authoritative per-cell provenance (contextual on, model IDs)
> is in each `kb-<ds>-hybrid+rerank+contextual-chunk-results.json`.
