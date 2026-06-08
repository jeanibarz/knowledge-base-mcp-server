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

## Recorded SciFact baselines (test split, 300 judged queries)

Embedding: **`ollama / nomic-embed-text`** (the project's shipped local model),
default chunking 1000/200, no cross-encoder rerank (rerank is M1).

| mode (file) | nDCG@10 | precision@10 | Recall@10 | Recall@100 |
|---|---|---|---|---|
| `lexical` source BM25 (`scifact-lexical.json`) | **0.6690** | 0.0870 | 0.7923 | 0.8959 |
| `dense` (`scifact-dense.json`) | 0.4914 | 0.0693 | 0.6107 | 0.8083 |
| `hybrid` RRF (`scifact-hybrid.json`) | 0.6109 | 0.0850 | 0.7629 | 0.9213 |

(The lexical 0.6690 reproduces the prior pure-BM25 record in
`../scifact-lexical-source-2026-05-28/` to 4 dp, validating the harness +
dataset conversion.)

## Acceptance metric (M0): NOT cleared by the as-shipped model ⚠️

> SciFact `hybrid` nDCG@10 recorded and **> lexical 0.669** by a significant
> margin.

**Measured result: hybrid = 0.611, which is _below_ lexical 0.669.** This is a
real, honest finding — and precisely what the harness exists to surface (RFC 020:
"make retrieval quality a first-class, honestly-measured quantity; measure before
build"). The RFC's hypothesised 0.74–0.77 band was an explicit *training-knowledge
hypothesis for Qwen3-Embedding-0.6B, pending verification* (RFC §Evidence base).
The harness verified it against the model the product actually ships and the
hypothesis does **not** hold here.

Diagnosed contributors (each a follow-up, not M0 scope):

1. **Model.** `nomic-embed-text` (137M) is much weaker than the RFC's assumed
   Qwen3-Embedding-0.6B, and SciFact (scientific claim verification) is a
   BM25-friendly domain.
2. **Missing task prefixes (bug).** `nomic-embed-text` requires
   `search_query:` / `search_document:` prefixes for retrieval; the embedding
   path does not add them, depressing dense quality. Tracked as a follow-up
   issue.
3. **No reranker.** The RFC's gain assumes dense + RRF **+ cross-encoder**;
   rerank lands in M1 (#561).
4. **Chunk vs. source BM25.** The lexical baseline scores whole-document
   (`--lexical-unit=source`) BM25, while hybrid fuses *chunk*-level BM25 with
   dense; at document-level scoring the chunk split dilutes the strong
   whole-doc BM25 signal — exactly the chunk-boundary effect precision@10 is
   here to expose.

The dense/hybrid harness is landed, tested, and now produces real, committed,
reproducible numbers. Clearing 0.669 is an M1+ question (rerank, nomic prefixes,
or a stronger embedding model), to be re-measured through this same harness.

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
  --modes=lexical,dense,hybrid
```
