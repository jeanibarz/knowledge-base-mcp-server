# NanoBEIR real-geometry dense gate fixtures (issue #1051)

The retrieval quality gate enforces on the provider-independent `lexical` BM25
baselines and on a hermetic 12-doc **`fake`-provider** fixture. The `fake`
provider "has no semantic geometry" (see `../../../results/beir/baseline/README.md`),
so that gate **cannot catch a real dense regression** — the blind spot exactly
where most model/pipeline changes land.

These fixtures close that blind spot. They vendor a small, capped subset of
[NanoBEIR](https://huggingface.co/zeta-alpha-ai) (the official downsized BEIR,
~50 queries/dataset) in the `corpus.jsonl` / `queries.jsonl` / `qrels/<split>.tsv`
layout the `benchmarks/beir/run.ts` runner reads via `--dataset-dir`, so the
dense gate runs the production dense path with a **real embedding model** over
**real text + real qrels** while staying inside the CI time budget and small
enough to vendor.

## Datasets

| Fixture | Upstream NanoBEIR | Domain | qrels |
|---|---|---|---|
| `nanobeir-scifact` | `zeta-alpha-ai/NanoSciFact` | scientific fact-checking | expert (binary) |
| `nanobeir-fiqa`    | `zeta-alpha-ai/NanoFiQA2018` | finance | crowdsourced (binary) |

Both are low pretraining-leakage, domain-diverse, and small enough that **every
judged doc fits under the corpus cap**. They are a separate `NANOBEIR_REGISTRY`
in `../../registry.ts` — deliberately **not** part of `BEIR_REGISTRY`/the headline
multi-domain mean or the Δ_g partition.

## Downsizing rule (deterministic, stable git diffs)

`build-nanobeir-fixtures.py` materialises each fixture by:

1. keeping **all** queries and **all** qrels pairs (NanoBEIR qrels are binary →
   `score=1`);
2. keeping **every judged doc** (so no qrel is orphaned);
3. adding unjudged *distractor* docs, chosen by sorted `_id`, up to a
   **1000-doc corpus cap**.

NanoBEIR's corpus has no `title` column, so the fixture writes `title: ""`. The
cap bounds CI time and fixture size while leaving enough distractors that a
weaker embedding model visibly drops nDCG@10 (the recorded baselines land near
0.80 / 0.65 — well inside `(0, 1)`, so the gate is sensitive, not saturated).

These are **real-geometry regression signals, not leaderboard numbers**: the cap
makes the absolute nDCG@10 our own, self-consistent baseline — the gate only ever
compares a fresh run against the committed baseline on the *same* fixture.

### Rebuild the fixtures

```bash
python3 benchmarks/beir/fixtures/nanobeir/build-nanobeir-fixtures.py
```

(Needs the `datasets` library and network to Hugging Face. Re-running is
deterministic.)

## Record / refresh the committed dense baselines

Baselines live beside the other BEIR results as
`benchmarks/results/beir/nanobeir-<dataset>-dense.json`, recorded with a **real**
embedding provider (the project's shipped local `ollama` / `nomic-embed-text`).
Baseline updates are an explicit, reviewed commit — never automatic.

```bash
# Ollama running with the embedding model pulled.
for ds in nanobeir-scifact nanobeir-fiqa; do
  node build/benchmarks/beir/run.js \
    --dataset="$ds" --dataset-dir="benchmarks/beir/fixtures/nanobeir/$ds" \
    --split=test --mode=dense \
    --provider=ollama --model="$OLLAMA_MODEL" \
    --output-dir=/tmp/kb-beir-nanobeir-out \
    --workspace-root=/tmp/kb-beir-nano-ws
  cp "/tmp/kb-beir-nanobeir-out/kb-$ds-dense-chunk-results.json" \
     "benchmarks/results/beir/$ds-dense.json"
done
```

## Run the gate locally

```bash
node build/benchmarks/beir/quality-gate.js \
  --datasets=nanobeir-scifact,nanobeir-fiqa --modes=dense \
  --provider=ollama \
  --dataset-dir=benchmarks/beir/fixtures/nanobeir \
  --baseline-dir=benchmarks/results/beir \
  --workspace-root=/tmp/kb-beir-nano-ws --output-dir=/tmp/kb-beir-nano-out \
  --fail-on-regression
```

The gate compares *like-for-like*: with no real provider reachable (e.g. hosted
CI with no Ollama) the fresh dense run fails and the cell is **SKIPPED**, never a
false failure; where the provider is reachable it **enforces** a statistically
significant nDCG@10 regression. This repo's CI policy makes local verification
the real merge gate, so the enforcing run is the operator's local gate (and any
self-hosted runner with the provider configured).
