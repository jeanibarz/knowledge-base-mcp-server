# Reranker model bake-off: lift × latency (#1049)

**Question.** Is there a cross-encoder that gives more nDCG@10 lift over plain
hybrid retrieval than the default `Xenova/ms-marco-MiniLM-L-6-v2`, per unit of
added latency — and should reranking be on by default?

**Short answer.** No reranker is a safe default-on, and none beats the MiniLM baseline by a
significant margin on any dataset. Every cross-encoder helps NFCorpus (+0.019 to +0.048) and all four
that ran on ArguAna *hurt* it (−0.041 to −0.207). `bge-reranker-v2-m3` (fp16, GPU) has the best
SciFact lift (+0.042, the only significant SciFact gain over hybrid; +0.026 over
MiniLM, not significant) and the best 3-dataset mean, at ~7–8× MiniLM's
rerank latency. **Recommendation: keep rerank
off by default, keep MiniLM-L6 as the default model when it is enabled, and
document bge-reranker-v2-m3 (fp16, CUDA) as an opt-in quality tier.**

Local BEIR runs on one shared machine — not a leaderboard submission.

## What was measured

- **Lift.** nDCG@10 of `hybrid+rerank` minus nDCG@10 of plain `hybrid`, on the
  same query set and the same retrieved candidates. nDCG@10 is a 0–1 score of
  how well the top 10 results are ordered.
- **Cost.** Latency the rerank stage adds per query, from an isolated probe
  (`rerank-latency-probe.mjs`) that times only the production
  `applyRerankerIfEnabled` call on each query's real top-40 hybrid documents
  (1000 characters each). See "Why latency comes from a separate probe".
- **Datasets.** SciFact (300 test queries), NFCorpus (323), ArguAna (first 300
  of 1,406 test queries — capped to fit the time box; the same 300 for every
  variant). Embedder: the current default `dengcao/Qwen3-Embedding-0.6B:Q8_0`.

## How it was run

- **Pipeline.** Production hybrid retrieval (dense Qwen3-Embedding-0.6B + BM25,
  RRF c=60) through `retrieveForRetrievalEvalCase`, then the production
  cross-encoder stage in `src/reranker.ts` (`KB_RERANK=on`, `KB_RERANK_TOP_N=40`,
  the default). Only `KB_RERANK_MODEL` / `KB_RERANK_DTYPE` change between rows.
- **One index per dataset.** `sweep-rerankers.mjs` (committed next to this README)
  calls the same `runBeirBenchmark` entrypoint as `node build/benchmarks/beir/run.js`
  but builds the index once per dataset and runs every variant against it; the
  only harness change is exporting `defaultRunDependencies` from
  `benchmarks/beir/run.ts` so the driver can wrap the backend loader. Every
  variant therefore reranks exactly the same hybrid candidates.
- **GPU.** `KB_RERANK_DEVICE=cuda`. The bundled `onnxruntime-node` 1.30 CUDA
  provider links against CUDA **13** (`libcudart.so.13`, `libcublas.so.13`) and
  cuDNN 9; this host only had CUDA 12 system libraries, so the CUDA 13 runtime,
  cuBLAS, cuFFT, cuRAND and cuDNN wheels were pip-installed into a scratch
  directory and put on `LD_LIBRARY_PATH`. Without that, `KB_RERANK_DEVICE=cuda`
  fails with `OrtSessionOptionsAppendExecutionProvider_Cuda: Failed to load shared library`.
- **dtype.** fp32 for every model except `bge-reranker-v2-m3`: its fp32 ONNX
  export is split into `model.onnx` + `model.onnx_data` (external weights) and the
  production loader does not request external data, so loading fails; the
  single-file fp16 export (`KB_RERANK_DTYPE=fp16`) loads and was used.
- **CPU path note.** The CPU branch of the loader passes `{ quantized: true }`,
  which transformers.js v3 ignores: a CPU smoke run of MiniLM produced logits
  identical to the CUDA fp32 run, i.e. the CPU path loads the fp32 `model.onnx`,
  not an int8 one.

## Results

| variant | scifact nDCG@10 (Δ) | nfcorpus nDCG@10 (Δ) | arguana nDCG@10 (Δ) | mean nDCG@10 | mean Δ | rerank-stage p50 ms (sf / nf / ag) | rerank-stage p95 ms (sf / nf / ag) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| hybrid (no rerank) | 0.6879 | 0.3101 | 0.4055 | 0.4678 | — | — | — |
| `minilm-l6` | 0.7039 (+0.0159) | 0.3517 (+0.0416) | 0.3361 (-0.0694) | 0.4639 | -0.0039 | 105 / 122 / 198 | 153 / 179 / 304 |
| `mxbai-xsmall-v1` | invalid (fail-open) | 0.3451 (+0.0351) | not run | n/a | n/a | 533 / 556 / 770 | 781 / 767 / 1253 |
| `jina-v1-turbo-en` | not run | 0.3363 (+0.0263) | not run | n/a | n/a | 141 / 144 / 189 | 221 / 248 / 298 |
| `bge-base` | 0.6785 (-0.0094) | 0.3294 (+0.0194) | 0.2483 (-0.1573) | 0.4187 | -0.0491 | 670 / 666 / 1076 | 892 / 822 / 1447 |
| `mxbai-base-v1` | 0.7092 (+0.0212) | 0.3576 (+0.0476) | 0.1985 (-0.2070) | 0.4218 | -0.0461 | 962 / 901 / 1386 | 1304 / 1145 / 2213 |
| `bge-v2-m3-fp16` | 0.7303 (+0.0423) | 0.3488 (+0.0387) | 0.3650 (-0.0405) | 0.4814 | +0.0135 | 842 / 832 / 1626 | 1165 / 977 / 4422 |

Columns: nDCG@10 with Δ vs plain hybrid in parentheses; *mean* only where all
three datasets have a valid cell; rerank-stage latency from the isolated probe
(next section). *not run* = cut for time; *invalid* = partial fail-open (see
checks).

### Why latency comes from a separate probe

In the sweep, "variant p50 − hybrid p50" mixes the reranker's cost with
whatever the shared host was doing during each 5–10-minute variant (other
sweeps, other tenants' GPU jobs, CPU-bound hybrid fusion at ~0.7–1.9 s/query).
Those differences were noisy enough to come out negative (MiniLM on NFCorpus
at chunk-k=1000: −120 ms), so they are kept only in `summary.json`
(`added_p50_ms`). The latency columns above come from
`rerank-latency-probe.mjs`: the production `applyRerankerIfEnabled` call
alone (tokenisation + GPU forward pass over 40 candidates of ≤1000 chars),
60 queries per dataset, each model warmed first, run while the GPU was still
shared — so read them as a relative ranking.

| reranker | dtype | SciFact p50 / p95 ms | NFCorpus p50 / p95 ms | ArguAna p50 / p95 ms | degraded calls |
| --- | --- | --- | --- | --- | --- |
| `Xenova/ms-marco-MiniLM-L-6-v2` | fp32 | 105 / 153 | 122 / 179 | 198 / 304 | 0 / 180 |
| `mixedbread-ai/mxbai-rerank-xsmall-v1` | fp32 | 533 / 781 | 556 / 767 | 770 / 1253 | 0 / 180 |
| `jinaai/jina-reranker-v1-turbo-en` | fp32 | 141 / 221 | 144 / 248 | 189 / 298 | 0 / 180 |
| `Xenova/bge-reranker-base` | fp32 | 670 / 892 | 666 / 822 | 1076 / 1447 | 0 / 180 |
| `mixedbread-ai/mxbai-rerank-base-v1` | fp32 | 962 / 1304 | 901 / 1145 | 1386 / 2213 | 0 / 180 |
| `onnx-community/bge-reranker-v2-m3-ONNX` | fp16 | 842 / 1165 | 832 / 977 | 1626 / 4422 | 0 / 180 |

Every probe call reranked (0 degraded). ArguAna is slower for every model because its queries are whole arguments, so each (query, passage) pair is longer.

### Significance

Paired bootstrap per dataset (`benchmarks/significance.ts`, 10k resamples), Holm-corrected within each family. Full output: `significance.md`.

### Each reranker vs plain hybrid

Correction: holm across 14 comparison(s) at α=0.05

| Comparison | n | Mean Δ | raw p | adj p | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| minilm-l6 vs hybrid (scifact) | 300 | +0.0159 | 0.2604 | 0.5208 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| minilm-l6 vs hybrid (nfcorpus) | 323 | +0.0416 | <0.0001 | <0.0001 | IMPROVEMENT |
| minilm-l6 vs hybrid (arguana) | 300 | -0.0694 | <0.0001 | <0.0001 | REGRESSION |
| mxbai-xsmall-v1 vs hybrid (nfcorpus) | 323 | +0.0351 | <0.0001 | 0.0001 | IMPROVEMENT |
| jina-v1-turbo-en vs hybrid (nfcorpus) | 323 | +0.0263 | 0.0012 | 0.0087 | IMPROVEMENT |
| bge-base vs hybrid (scifact) | 300 | -0.0094 | 0.4968 | 0.5208 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| bge-base vs hybrid (nfcorpus) | 323 | +0.0194 | 0.0100 | 0.0502 | NO-SIGNIFICANT-CHANGE |
| bge-base vs hybrid (arguana) | 300 | -0.1573 | <0.0001 | <0.0001 | REGRESSION |
| mxbai-base-v1 vs hybrid (scifact) | 300 | +0.0212 | 0.1412 | 0.4236 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| mxbai-base-v1 vs hybrid (nfcorpus) | 323 | +0.0475 | <0.0001 | <0.0001 | IMPROVEMENT |
| mxbai-base-v1 vs hybrid (arguana) | 300 | -0.2070 | <0.0001 | <0.0001 | REGRESSION |
| bge-v2-m3-fp16 vs hybrid (scifact) | 300 | +0.0423 | 0.0060 | 0.0360 | IMPROVEMENT |
| bge-v2-m3-fp16 vs hybrid (nfcorpus) | 323 | +0.0387 | <0.0001 | <0.0001 | IMPROVEMENT |
| bge-v2-m3-fp16 vs hybrid (arguana) | 300 | -0.0405 | 0.0145 | 0.0581 | NO-SIGNIFICANT-CHANGE |

Non-significant rows are reported, not failed (RFC 020 §3/§4).

### Each reranker vs the MiniLM-L6 baseline reranker

Correction: holm across 11 comparison(s) at α=0.05

| Comparison | n | Mean Δ | raw p | adj p | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| mxbai-xsmall-v1 vs minilm-l6 (nfcorpus) | 323 | -0.0066 | 0.2734 | 1.0000 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| jina-v1-turbo-en vs minilm-l6 (nfcorpus) | 323 | -0.0153 | 0.0031 | 0.0247 | REGRESSION |
| bge-base vs minilm-l6 (scifact) | 300 | -0.0253 | 0.0207 | 0.1450 | NO-SIGNIFICANT-CHANGE |
| bge-base vs minilm-l6 (nfcorpus) | 323 | -0.0223 | 0.0001 | 0.0013 | REGRESSION |
| bge-base vs minilm-l6 (arguana) | 300 | -0.0878 | <0.0001 | <0.0001 | REGRESSION |
| mxbai-base-v1 vs minilm-l6 (scifact) | 300 | +0.0053 | 0.6830 | 1.0000 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| mxbai-base-v1 vs minilm-l6 (nfcorpus) | 323 | +0.0059 | 0.2746 | 1.0000 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| mxbai-base-v1 vs minilm-l6 (arguana) | 300 | -0.1376 | <0.0001 | <0.0001 | REGRESSION |
| bge-v2-m3-fp16 vs minilm-l6 (scifact) | 300 | +0.0264 | 0.0290 | 0.1742 | NO-SIGNIFICANT-CHANGE |
| bge-v2-m3-fp16 vs minilm-l6 (nfcorpus) | 323 | -0.0029 | 0.5944 | 1.0000 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| bge-v2-m3-fp16 vs minilm-l6 (arguana) | 300 | +0.0289 | 0.1052 | 0.5259 | INCONCLUSIVE-BELOW-NOISE-FLOOR |

Non-significant rows are reported, not failed (RFC 020 §3/§4).


### Fail-open checks (why one cell is marked invalid)

`src/reranker.ts` fails **open**: if the cross-encoder throws (here: a CUDA
out-of-memory on the shared GPU), the query silently keeps the hybrid order.
A row can therefore look like a valid measurement while part of it is just
hybrid. `aggregate.py` checks every rerank cell three ways: (1) is the
per-query nDCG@10 vector identical to hybrid's, (2) is Recall@100 identical to
hybrid's (it must be — reranking only reorders the top 40), and (3) how many
queries kept exactly hybrid's top-10 order (from the TREC run files).

- SciFact `minilm-l6`, first attempt: **every** query degraded (nDCG@10 equal to
  hybrid's 0.6879) — a CUDA OOM at model load. Discarded and re-run after the
  sweep gained a load-and-retry guard (`ensureRerankerLoads`) and model disposal
  between variants; the table shows the re-run.
- SciFact `mxbai-xsmall-v1`: the first **66 consecutive** queries kept hybrid's
  order — a fail-open burst during the same OOM period — so the cell blends
  hybrid and rerank. It is shown as *invalid* and excluded from the
  significance families. Not re-run (time box).
- ArguAna `minilm-l6`, `bge-base`, `mxbai-base-v1`: 14, 22 and 14 of 300
  queries kept hybrid's exact top-10 order, and **the 14 are the same query IDs
  for all three models** — so this is deterministic, not GPU noise. Those 14
  are the longest queries in the set (392–868 words; the ArguAna median is
  174), i.e. longer than the 512-token window of these three cross-encoders;
  `bge-reranker-v2-m3` (8,192-token window) shows 0 such queries. Most likely
  the cross-encoder call throws on an over-length (query, passage) pair and
  the production reranker fails open to the fused order (not verified at the
  exception level). This is a **production finding**: with a 512-token
  cross-encoder, very long queries are silently not reranked (worth a check
  against the #1019 degrade metric and a test). The cells are kept (under the
  10 % invalidity threshold); those queries carry a zero delta, so the
  regressions shown are, if anything, understated.
- Every other cell: 0 queries with hybrid's top-10 order, Recall@100 identical to
  hybrid's.

## Recommendation

1. **Keep reranking off by default (`KB_RERANK` unset).** Every reranker that
   ran on ArguAna made it *worse* than plain hybrid
   (MiniLM −0.069, bge-reranker-base −0.157, mxbai-rerank-base −0.207, all
   significant; bge-reranker-v2-m3 −0.041, adj. p 0.058 after Holm).
   ArguAna queries are whole arguments and the task is "find the
   counter-argument" — the opposite of the short-question → answer-passage
   pairs these MS MARCO-style cross-encoders learned. The June Qwen3 matrix
   showed the same pattern (ArguAna hybrid 0.4294 → 0.3325 with MiniLM).
   Gains elsewhere are real but domain-dependent: NFCorpus improves
   significantly with every model except bge-reranker-base (+0.019, adj. p
   0.050); SciFact gains are not significant for
   MiniLM. This matches RFC 020 §9's rule — rerank only behind a per-domain
   measurement and `KB_RERANK_SKIP_DOMAINS`.
2. **Default model when rerank is enabled: keep `Xenova/ms-marco-MiniLM-L-6-v2`.**
   It is the cheapest (≈105–200 ms per query for 40 candidates on GPU in the
   probe) and no candidate beat it by a significant margin on both
   lift-positive datasets (see the vs-MiniLM family). On the
   lift-per-millisecond trade-off it wins clearly.
3. **Quality tier: `onnx-community/bge-reranker-v2-m3-ONNX` with
   `KB_RERANK_DEVICE=cuda KB_RERANK_DTYPE=fp16`.** Best SciFact lift (+0.042),
   the best 3-dataset mean (0.4814 vs hybrid 0.4678) and the smallest ArguAna
   regression of the models run there — at roughly 7–8× MiniLM's rerank latency
   (≈830–1,630 ms p50 in the probe). Worth documenting as an opt-in tier for
   GPU hosts; not worth making the default. Its fp32 export does not load
   through the production loader (external-data ONNX, see above).
4. **Drop from consideration:** `Xenova/bge-reranker-base` (worst on two of three
   sets, −0.157 on ArguAna), `mxbai-rerank-xsmall-v1` and
   `jina-reranker-v1-turbo-en` (below MiniLM on NFCorpus, not faster).
   `mixedbread-ai/mxbai-rerank-base-v1` ties MiniLM on SciFact/NFCorpus (Δ vs MiniLM +0.005/+0.006, not significant) at ~8× the latency and is the worst of all on ArguAna (−0.207).
5. **topN:** not swept; keep 40.

## What was not run, and why

- **Narrowed matrix.** All six candidates ran on NFCorpus. SciFact dropped
  `jina-reranker-v1-turbo-en`; ArguAna ran only `minilm-l6`, `bge-base`,
  `mxbai-base-v1` and `bge-v2-m3`. Reason: the CPU-side hybrid stage costs
  0.7–1.9 s/query on this shared host, so each variant took 5–10 minutes.
  The two dropped models were below MiniLM on NFCorpus (`jina` +0.026,
  `mxbai-xsmall` +0.035 vs MiniLM +0.042) and not faster than it; bge-base
  (+0.019) stayed in as the issue's named bge-family candidate.
- **SciFact `mxbai-xsmall-v1` is invalid** (partial fail-open, see the checks
  above) and was not re-run.
- **ArguAna: first 300 of 1,406 queries** (`--max-queries=300`, the same 300 for
  hybrid and every reranker).
- **Not run at all:** `Qwen3-Reranker` (a generative yes/no reranker, not a
  sequence-classification cross-encoder, so `src/reranker.ts` cannot load it),
  `mxbai-rerank-*-v2` (Qwen2-based, same problem), `jina-reranker-v2-base-multilingual`
  (custom architecture; no transformers.js-loadable ONNX export was tried), and
  hosted rerank APIs (Cohere, Voyage: no keys on this host, and the server has no
  hosted-rerank provider).
- `topN` was not swept; every row uses the default 40.

## Caveats

- **Single run, single machine**: one RTX 3090 shared with other live GPU
  tenants (Ollama generation models), 16 cores. Up to three sweep processes ran
  at once.
- **chunk-k=100.** The hybrid and rerank variants fetch 100 fused chunks per
  query (`--chunk-k=100`, the value `benchmarks/beir/reranker-bakeoff.ts`
  uses), not the runner default of 1000, to fit the time box. Hybrid nDCG@10 is
  therefore slightly different from the committed Qwen3 matrix
  (`../beir/matrix/qwen3/`); NFCorpus hybrid was measured both ways — 0.3145 at
  chunk-k=1000 vs 0.3101 at chunk-k=100, and MiniLM rerank 0.3540 vs 0.3517 —
  so the *lift* is essentially unchanged (+0.0395 vs +0.0416). Those two
  chunk-k=1000 rows are not part of the tables.
- `KB_RERANK_BATCH_SIZE=10` (#746 sub-batching) for the SciFact and ArguAna
  rerank runs to bound GPU memory on the shared card. Sub-batching only changes
  call shape and peak memory, not the scores' order.
- **Small-dataset scope is deliberate**: three small BEIR sets (two scientific /
  medical). They cannot speak for code, skills or other high-precision corpora,
  where the KB survey found cross-encoders hurt (RFC 020 §9).

## Reproduce

```bash
npm ci && npm run build && npx tsc -p tsconfig.bench.json
export KB_RERANK_DEVICE=cuda LD_LIBRARY_PATH=<CUDA 13 + cuDNN 9 lib dirs>
WS=<empty scratch dir>; OUT=<output dir>
# Each sweep builds the dataset's index once (dense variant), then runs hybrid
# and every rerank variant against it. The env must point at the first
# variant's workspace (<ws-root>/<dataset>-dense) before node starts.
for D in scifact nfcorpus arguana; do
  EXTRA=""; [ "$D" = arguana ] && EXTRA="--max-queries=300"
  KNOWLEDGE_BASES_ROOT_DIR=$WS/$D-dense/knowledge-bases FAISS_INDEX_PATH=$WS/$D-dense/.faiss \
  node benchmarks/results/reranker-bakeoff/sweep-rerankers.mjs \
    --dataset=$D --out=$OUT --ws-root=$WS --chunk-k=100 $EXTRA
done
# --only=<ids> limits the variants; --reuse-index=1 re-attaches to an existing
# <ws-root>/<dataset>-dense index instead of rebuilding it.
node benchmarks/results/reranker-bakeoff/rerank-latency-probe.mjs \
  $HOME/.cache/kb-beir-cache/scifact $OUT/scifact/hybrid/kb-scifact-hybrid-chunk-run.trec 60 rerank-latency-scifact.json
python3 -I benchmarks/results/reranker-bakeoff/aggregate.py benchmarks/results/reranker-bakeoff $OUT
python3 -I benchmarks/results/embedding-bakeoff/make-significance-families.py
node build/benchmarks/significance.js --family=benchmarks/results/reranker-bakeoff/significance-family-vs-hybrid.json --correction=holm
```

What actually ran differs from that clean recipe in ways recorded above: the
NFCorpus sweep's first pass used `KB_QUERY_CACHE=off` and chunk-k=1000 (kept
only as the comparison rows in the chunk-k caveat); SciFact and ArguAna were
resumed with `--reuse-index=1 --only=...` after the OOM / time-box changes, with
`KB_RERANK_BATCH_SIZE=10`; ArguAna `bge-v2-m3` ran in a separate parallel
process against the same index.

## Files

- `runs/<dataset>/<variant>/kb-*-results.json` — full run reports with per-query
  nDCG@10 vectors (`hybrid` = no rerank).
- `summary.json` — aggregate written by `aggregate.py` (deltas, checks).
- `rerank-latency.json` — isolated rerank-stage latency probe.
- `significance-family-vs-hybrid.json` / `-vs-minilm.json` and
  `significance.md` — paired-bootstrap comparisons (`benchmarks/significance.ts`),
  Holm-corrected within each family.
- `sweep-rerankers.mjs`, `rerank-latency-probe.mjs`, `aggregate.py` — the
  drivers used.
