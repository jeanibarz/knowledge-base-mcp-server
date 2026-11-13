# Embedding-model bake-off: quality × speed (#1047)

**Question.** Is there an embedding model that retrieves better than the current
Ollama default, `dengcao/Qwen3-Embedding-0.6B:Q8_0`, while being as fast or
faster?

**Short answer.** Not cleanly. `nomic-embed-text` (with its task prefixes) is 3.6× faster
to index, 4.5× faster per query, and better on SciFact (+0.060) and NFCorpus
(+0.104) — but it is significantly **worse on ArguAna (−0.090)**; its 3-set mean
is still higher (0.4740 vs 0.4494). `mxbai-embed-large` is the best model on
NFCorpus (+0.135) at 2× the default's speed but only ran that one dataset. The
default, as this server runs it, indexes the slowest of the five models with
quality numbers (granite is slower per query) and is last on NFCorpus — but it also runs without the
query instruction its model card asks for. **Recommendation: keep the default
for now (do not flip on this evidence alone) and run the two cheap follow-ups
below, which decide it.**

Local BEIR runs on one shared machine — not a leaderboard submission. Read the
caveats before acting on any single number.

## What was measured

- **Retrieval quality — nDCG@10.** A 0–1 score of how well the top 10 results
  are ordered (1.0 = every relevant document ranked first). Measured in **dense
  mode**: embedding-only retrieval, no BM25 and no reranker, so the number
  reflects the embedding model alone. The production path runs end to end
  (`benchmarks/beir/run.ts --mode=dense`: `FaissIndexManager` indexing with the
  default 1000/200 chunking, `retrieveForRetrievalEvalCase` search, chunk →
  document max-pool roll-up).
- **Datasets.** Three small BEIR sets, chosen on purpose so a full model sweep
  fits a ~3-hour budget: SciFact (5,183 docs / 300 test queries, scientific
  claims), NFCorpus (3,633 / 323, bio-medical), ArguAna (8,674 / 1,406,
  counter-argument retrieval). NFCorpus and ArguAna were fetched from the
  canonical UKP BEIR zips; SciFact was already in the local BEIR cache.
- **Speed.** Two numbers, because the host GPU was shared with other live
  Ollama workloads:
  - *Observed index throughput*: chunks embedded per second during each BEIR
    index build (`indexing.chunks / indexing.ms` in the run report). Honest
    end-to-end, but it swings with whatever else the GPU was doing — treat it as
    a sanity check, not a ranking.
  - *Controlled speed probe* (`speed-microbench.py`): the same 256 SciFact chunks
    (1000 chars, batches of 16 — the server's Ollama indexing batch) and the same
    60 SciFact queries (one request each) sent to every model, serially, in two
    round-robin rounds; the table shows the median of the two rounds. This is
    the number the speed comparison uses.
- **Index size.** The FAISS index here is a flat float32 index, so its size is
  chunks × dimension × 4 bytes (checked against the measured `faiss.index`
  files in `index-sizes.jsonl`: e.g. Qwen3 SciFact 61,251,629 bytes measured vs
  61,251,584 predicted, a 45-byte header).

## Results

| model | scifact | nfcorpus | arguana | mean sf+nf | mean (3 sets) | observed chunks/s | probe chunks/s | probe query p50 / p95 ms | dim | index MB (NFCorpus) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `mxbai-embed-large` | not run | 0.3796 | not run | n/a | n/a | 19.2 | 23.0 | 69 / 103 | 1024 | 44.9 |
| `nomic-embed-text` | 0.6989 | 0.3487 | 0.3744 | 0.5238 | 0.4740 | 30.5 | 39.6 | 54 / 80 | 768 | 33.7 |
| `granite-embedding:278m` | not run | 0.2818 | not run | n/a | n/a | 19.3 | 16.0 | 351 / 387 | 768 | 33.7 |
| `embeddinggemma` | not run | 0.2759 | not run | n/a | n/a | 18.2 | 14.1 | 249 / 287 | 768 | 33.7 |
| `dengcao/Qwen3-Embedding-0.6B:Q8_0` | 0.6389 | 0.2451 | 0.4641 | 0.4420 | 0.4494 | 12.1 | 11.1 | 244 / 278 | 1024 | 44.9 |
| `nomic-embed-text-v2-moe` | not run | not run | not run | n/a | n/a | n/a | 9.7 | 338 / 373 | 768 | n/a |
| `bge-m3` | not run | not run | not run | n/a | n/a | n/a | 11.3 | 369 / 401 | 1024 | n/a |

Columns: per-dataset dense nDCG@10 (NFCorpus is the only column every
quality-measured model ran; *not run* = cut for time); *mean sf+nf* = mean over
SciFact and NFCorpus where both ran; *mean (3 sets)* only where all three ran;
*observed chunks/s* = summed chunks ÷ summed index-build time across the sets
that model ran; *probe* columns from the controlled speed probe; *index MB
(NFCorpus)* = flat float32 vector bytes for the NFCorpus index (10,972 chunks
for every model, so it isolates the effect of the vector dimension).

Paired bootstrap per dataset (`benchmarks/significance.ts`, 10k resamples,
Holm-corrected across the family), each model against the default on the
same queries — see `significance.md`:

| Comparison | n | Mean Δ | raw p | adj p | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| embeddinggemma vs qwen3 (nfcorpus) | 323 | +0.0309 | 0.0042 | 0.0052 | IMPROVEMENT |
| granite-embedding_278m vs qwen3 (nfcorpus) | 323 | +0.0367 | 0.0026 | 0.0052 | IMPROVEMENT |
| mxbai-embed-large vs qwen3 (nfcorpus) | 323 | +0.1345 | <0.0001 | <0.0001 | IMPROVEMENT |
| nomic-embed-text vs qwen3 (scifact) | 300 | +0.0600 | 0.0002 | 0.0007 | IMPROVEMENT |
| nomic-embed-text vs qwen3 (nfcorpus) | 323 | +0.1036 | <0.0001 | <0.0001 | IMPROVEMENT |
| nomic-embed-text vs qwen3 (arguana) | 1406 | -0.0897 | <0.0001 | <0.0001 | REGRESSION |

## Pareto call

The selection rule from #1047 is "retrieve better than the default while
being as fast or faster". Speed here = the controlled probe (index chunks/s
and per-query embed latency); quality = dense nDCG@10 on the datasets each
model ran.

| model | speed vs default (probe) | quality vs default (dense nDCG@10) | on the frontier? |
| --- | --- | --- | --- |
| `nomic-embed-text` | **3.6× faster indexing** (39.6 vs 11.1 chunks/s), **4.5× faster queries** (54 vs 244 ms p50), 25 % smaller index (768-d) | **+0.060 SciFact, +0.104 NFCorpus** (both significant after Holm); ArguAna **−0.090** (0.3744 vs 0.4641, significant regression) | **Yes — dominates the default** on every measured axis except ArguAna — faster everywhere and better on the 3-set mean (0.4740 vs 0.4494), but not a uniform quality win |
| `mxbai-embed-large` | 2.1× faster indexing (23.0), 3.6× faster queries (69 ms), same 1024-d size | **+0.135 NFCorpus** (best of all, significant); SciFact / ArguAna not run | Yes on the one dataset measured — needs SciFact/ArguAna before it can be called |
| `granite-embedding:278m` | 1.4× faster indexing (16.0) but **slower queries** (351 vs 244 ms) | +0.037 NFCorpus (significant) | No — fails "as fast" on query latency |
| `embeddinggemma` | 1.3× faster indexing (14.1), queries about equal (249 vs 244 ms) | +0.031 NFCorpus (significant) | Borderline; dominated by nomic and mxbai on both axes |
| `nomic-embed-text-v2-moe` | slower (9.7 chunks/s, 338 ms) | not measured | No — fails the speed rule |
| `bge-m3` | indexing a tie (11.3), slower queries (369 ms) | not measured | No — fails the speed rule on query latency |
| `dengcao/Qwen3-Embedding-0.6B:Q8_0` (default) | 11.1 chunks/s, 244 ms | baseline | Dominated |

Note the context for the default: the June 2026 matrix that compared Qwen3
with nomic (`../beir/matrix/nomic/`, dense mean 0.255) ran nomic **without** its
`search_query:`/`search_document:` prefixes — the bug fixed in #567/#587. With
the prefixes on, nomic SciFact dense rose from 0.491 to 0.699
(`../beir/baseline/README.md`), and that is what this run measures. The
`docs/reference/embedding-models.md` quality cell for nomic (0.255) still comes
from that pre-fix matrix.

## Recommendation

**Keep `dengcao/Qwen3-Embedding-0.6B:Q8_0` as the Ollama default for now;
no code change in this PR.** Why not switch to nomic despite the 3-set mean
and the speed:

1. The win is not uniform. nomic loses ArguAna by 0.090 nDCG@10 (significant,
   1,406 queries), the one non-scientific domain here. Two of the three sets are
   scientific/biomedical, so the 3-set mean flatters it.
2. The default is handicapped in this comparison: Qwen3-Embedding is trained to
   see `Instruct: <task>\nQuery: <q>` on queries and this server sends raw
   text, while nomic gets its prefixes. Its NFCorpus score (0.245, last of five)
   is the kind of short keyword-query set where a missing instruction hurts most.
3. `mxbai-embed-large`, the strongest NFCorpus model and 2× faster than the
   default, has no SciFact/ArguAna numbers yet.

**Follow-ups that decide the default (each ~30–40 min on this host):**
(a) re-run the three Qwen3 dense cells with its query instruction applied (the
prefix registry in `src/embedding-provider.ts` is the only change needed);
(b) run `mxbai-embed-large` (with its `Represent this sentence for searching
relevant passages: ` query prompt) on SciFact and ArguAna.
If instructed Qwen3 still trails nomic on SciFact/NFCorpus, switch the default to
`nomic-embed-text` for its 3.6×/4.5× speed advantage and accept the ArguAna
loss — or to `mxbai-embed-large` if it holds up on the other two sets.

**Do not adopt:** `granite-embedding:278m` (faster indexing but slower queries
than the default), `nomic-embed-text-v2-moe` and `bge-m3` (slower than the
default per query in the probe, so they fail the speed rule whatever their
quality).

## Task prefixes: what each model got

Several embedding models are trained to see a short instruction in front of the
query (and sometimes the document). The server adds one only for the
`nomic-embed-text` family (`src/embedding-provider.ts`, `embeddingTaskPrefixesFor`),
and Ollama's `/api/embed` does not add one either. So this bake-off measures
each model **as this server runs it today**, not at its best:

| model | recommended by the model card | applied here |
| --- | --- | --- |
| `dengcao/Qwen3-Embedding-0.6B:Q8_0` | query: `Instruct: <task>\nQuery: <q>`; documents raw | **No** |
| `nomic-embed-text` (v1.5) | `search_query: ` / `search_document: ` | Yes |
| `nomic-embed-text-v2-moe` | `search_query: ` / `search_document: ` | Yes (same matcher) |
| `embeddinggemma` | query `task: search result \| query: `; document `title: none \| text: ` | **No** |
| `mxbai-embed-large` | query `Represent this sentence for searching relevant passages: `; documents raw | **No** |
| `bge-m3` | none for dense retrieval | n/a |
| `granite-embedding:278m` | none | n/a |

The models marked **No** (including the current default) could score higher
with their prompt. That is a separate, cheap follow-up (extend the prefix
registry, re-run this table); it is not measured here.

## What was not run, and why

Each dense quality run re-embeds a whole corpus through Ollama, and Ollama on
this host keeps only one of these embedding models resident next to other
tenants' models, so runs had to be strictly serial (10–20 minutes each under
the shared load). To stay inside the ~3-hour budget:

- **`nomic-embed-text-v2-moe` and `bge-m3`: speed probe only, no quality run.**
  In the probe, nomic-v2-moe is slower than the default on both axes (9.7 vs
  11.1 chunks/s, 338 vs 244 ms query p50) and bge-m3 ties it on indexing (11.3
  vs 11.1 chunks/s) but is slower per query (369 vs 244 ms), so neither can
  satisfy the "as fast or faster" rule regardless of quality. That is why they were the ones
  cut. The issue's acceptance asks for ≥6 models in the quality×speed matrix:
  this run has 7 in the speed column but only 5 in the quality columns.
- **`snowflake-arctic-embed2`: pulled, not run** (same 568M XLM-R size class as
  bge-m3; cut first).
- **SciFact and ArguAna for `embeddinggemma`, `granite-embedding:278m`,
  `mxbai-embed-large`: not run.** NFCorpus was run for every quality model so
  that one column is complete; SciFact was the next column and did not fit.
- `nomic-embed-text` ArguAna: run (0.3744, see table).
- One nomic ArguAna attempt failed with `embedding provider embedDocuments
  exceeded 120000ms deadline` after the process was paused (SIGSTOP) to stop
  it thrashing the shared Ollama; it was re-run from scratch.
- No API-tier models (OpenAI / Voyage / Gemini) and no Qwen3-Embedding-4B
  (larger than the ≤1.3 GB pull limit for this host).

## Caveats

- **Single run, single machine.** One RTX 3090 (24 GB) shared with other live
  Ollama tasks (a `qwen3:1.7b` generation workload was resident throughout), 16
  cores, Ollama `OLLAMA_CONTEXT_LENGTH=16384`. The observed index throughput
  varies run to run with that load; several builds also overlapped GPU reranker
  runs from the #1049 sweep — and so did the speed probe itself (its two rounds
  agree within ~10 %, see `speed-microbench.json`). The probe reduces but does
  not remove this noise; treat speed ratios below ~1.3× as ties.
- **Ollama keeps only one of these embedding models resident next to the other
  tenants' models.** Running two embedding jobs at once made Ollama swap models
  on almost every request, so the quality runs were serialised once this was
  caught. Before that, the nomic SciFact/NFCorpus builds and the Qwen3 NFCorpus
  build overlapped each other (and an aborted bge-m3 build); their *observed*
  throughput is unreliable. Every later build (Qwen3 SciFact/ArguAna, granite,
  embeddinggemma, mxbai, nomic ArguAna) was the only Ollama embedding job, but
  ran alongside the #1049 GPU reranker sweeps. No speed claim uses the observed
  column; nDCG@10 is unaffected by any of this (embeddings are deterministic).
- **Small-dataset scope is deliberate.** Three small BEIR sets, two of them
  scientific/medical. They answer "is anything clearly better than the
  default?", not "which model is best in general".
- **Dense only.** Production search defaults to hybrid (dense + BM25), where
  the gap between embedders usually narrows.
- Quality anchors reproduce earlier committed runs: nomic SciFact 0.6989
  (baseline README, 0.6989); Qwen3 SciFact 0.6389 / NFCorpus 0.2451 / ArguAna
  0.4641 vs the June matrix 0.6413 / 0.2457 / 0.4630.

## Reproduce

```bash
npm ci && npm run build && npx tsc -p tsconfig.bench.json
# one dense run (repeat per model × dataset); keep the workspace to size the index
node build/benchmarks/beir/run.js --dataset=scifact --cache-dir=$HOME/.cache/kb-beir-cache \
  --mode=dense --provider=ollama --model=nomic-embed-text \
  --output-dir=<out> --workspace-root=<empty scratch dir>
# controlled speed probe (serial, 2 rounds)
python3 -I benchmarks/results/embedding-bakeoff/speed-microbench.py \
  $HOME/.cache/kb-beir-cache/scifact speed-microbench.json 2 <model> [<model> ...]
# tables + summary.json from runs/ + index-sizes.jsonl + speed-microbench.json
python3 -I benchmarks/results/embedding-bakeoff/aggregate.py benchmarks/results/embedding-bakeoff
```

The Qwen3 rows come from the dense variant of the #1049 reranker sweep
(`../reranker-bakeoff/sweep-rerankers.mjs`), which built the Qwen3 index once
per dataset and reused it for the hybrid/rerank runs; the dense report is the
same `runBeirBenchmark` output as a stand-alone `--mode=dense` run.

## Files

- `runs/<model>/kb-<dataset>-dense-chunk-results.json` — full run reports
  (metrics, per-query nDCG@10 vectors, latency, index timing, git SHA).
- `summary.json` — per-model aggregate written by `aggregate.py`.
- `speed-microbench.json` — controlled speed probe, raw rounds + medians.
- `index-sizes.jsonl` — measured on-disk sizes.
- `significance-family.json` / `significance.md` — paired-bootstrap comparisons
  (`benchmarks/significance.ts`) of each model against the default, per dataset,
  Holm-corrected.
