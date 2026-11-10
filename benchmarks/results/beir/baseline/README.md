# BEIR CI-subset baselines (RFC 020 §4, milestone M0)

This directory holds the committed BEIR baselines, one JSON report per
`(dataset × mode)`:

```
<dataset>-<mode>.json     e.g. scifact-hybrid.json, scifact-lexical.json
```

Each file is the full `benchmarks/beir/run.ts` report and is self-describing:
it carries the commit (`git_sha`), the runtime (`runtime`), the embedding
provider/model (`embedding`), and the chunking (`chunking`) that produced it, so
any third party can reproduce the number from commit + env (the RFC §7
reproducibility contract). Baseline updates are an **explicit, reviewed commit**
(`chore(bench): update BEIR baseline`), never automatic — the same discipline as
the latency budget baselines.

## The CI quality gate (RFC 020 §4, M3)

`benchmarks/beir/quality-gate.ts` is the quality sibling of the latency
`budget-diff` gate. On a PR touching retrieval code, the
`retrieval-quality-gate.yml` workflow re-runs the CI-subset sweep hermetically
(lexical always; dense via the deterministic `fake` provider) and compares the
fresh nDCG@10 against these committed baselines. A `(dataset × mode)` cell FAILS
**only** when nDCG@10 drops below `baseline − tolerance` (relative %, with an
absolute floor) **and** the drop is statistically significant per
`benchmarks/significance.ts`. A non-significant dip is reported, not failed.

The gate compares *like-for-like*: a cell whose baseline was produced by a
different embedding provider than the current run (e.g. a real `ollama` baseline
vs a hermetic `fake` run) is SKIPPED, not failed. So the CI-subset gate enforces
on the provider-independent `lexical` BM25 baselines (deterministic), while the
`fake`-provider dense cells need a matching `fake` baseline to be enforced.

### `gate-fixture-*.json` — the hermetic gate baselines

`gate-fixture-lexical.json` and `gate-fixture-dense.json` are recorded on the
vendored fixture corpus at `benchmarks/beir/fixtures/gate/gate-fixture` (12 docs,
10 queries). Both run fully offline — lexical BM25 and dense via the `fake`
provider — so the gate has an always-available, network-free, deterministic cell
that genuinely fails the build if a retrieval change makes the fixture nDCG@10
regress significantly. These are plumbing baselines, not quality baselines (the
`fake` provider has no semantic geometry).

## Recorded SciFact baselines (test split, 300 judged queries) — re-measured 2026-11-10 (#1046)

Embedding: **`ollama / nomic-embed-text`** (the project's shipped local model),
default chunking 1000/200, task prefixes **on** (`search_query:` /
`search_document:`, fixed in #587, now the default). `hybrid+rerank` uses
`Xenova/ms-marco-MiniLM-L-6-v2`, topN=40 (#561).

| mode (file) | nDCG@10 | precision@10 | Recall@10 | Recall@100 |
|---|---|---|---|---|
| `lexical` source BM25 (`scifact-lexical.json`) | **0.6690** | 0.0870 | 0.7923 | 0.8959 |
| `dense` (`scifact-dense.json`) | 0.6989 | 0.0927 | 0.8182 | 0.9450 |
| `hybrid` RRF (`scifact-hybrid.json`) | 0.7073 | 0.0943 | 0.8471 | 0.9653 |
| `hybrid+rerank` (`scifact-hybrid+rerank.json`) | 0.7079 | 0.0940 | 0.8374 | 0.9653 |

Δ vs the stale pre-prefix / pre-rerank record (0.4914 dense, 0.6109 hybrid):
dense **+0.2075**, hybrid **+0.0964**. Rerank adds only +0.0007 over hybrid
(well inside the nDCG@10 SE of ~0.021, i.e. not significant here).

## Acceptance metric (M0): cleared on nDCG@10, but not by a significant margin

> SciFact `hybrid` nDCG@10 recorded and **> lexical 0.669** by a significant
> margin.

hybrid 0.7073 vs lexical 0.6690 is +0.038: above lexical, but smaller than the
~0.053 MDE at this query count (SE ≈ 0.022 per mode), so the "significant
margin" wording is not demonstrated by this run alone. The earlier "hybrid
below lexical" finding was an artifact of the missing task prefixes (#587):
enabling them lifts dense from 0.491 to 0.699, which alone clears lexical. The
cross-encoder rerank gives no measurable SciFact gain on top of hybrid (and
costs p50 ≈ 3.4 s/query on this machine). Single run, single machine; the
chunk-level hybrid still scores differently from whole-document BM25, so the
comparison is not perfectly like-for-like.

## Reproduce / extend

The canonical BEIR zip host (`public.ukp.informatik.tu-darmstadt.de`) was
unreachable from the build environment, so the SciFact corpus was fetched from
the **Hugging Face `BeIR` mirror** (parquet corpus/queries + TSV qrels) and
converted to the `corpus.jsonl` / `queries.jsonl` / `qrels/test.tsv` layout the
runner expects, then passed via `--dataset-dir`. See `../chunk-sweep/` for the
chunk-size sensitivity curves.

```bash
# Lexical + dense + hybrid for a local dataset dir (Ollama running):
node build/benchmarks/beir/run.js --dataset=scifact --dataset-dir=<dir> \
  --mode=hybrid --provider=ollama --model=nomic-embed-text \
  --output-dir=benchmarks/results/beir/baseline

# Or, when the dataset host is reachable, the built-in fetch + CI subset:
npm run bench:beir:baseline -- --provider=ollama --model=nomic-embed-text \
  --modes=lexical,dense,hybrid,hybrid+rerank
```
