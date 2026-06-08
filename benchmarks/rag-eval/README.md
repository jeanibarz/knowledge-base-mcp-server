# End-to-end RAG eval — human-label-free four-tier cascade

RFC 020 §5 (milestone M4). Protects the `kb ask` product surface **using no
human-annotated labels**. Correctness comes from gold-bearing public QA datasets
and automated cross-checks, structured as a deterministic-first cascade so the
LLM is used only where nothing cheaper can decide.

## The four tiers

| Tier | What it does | Module | Model in loop? |
|---|---|---|---|
| 1 | Exact-match + token-F1 vs gold answer; context recall/precision vs gold supporting facts | `reference.ts` | No |
| 2 | NLI/entailment faithfulness; BERTScore/COMET semantic similarity | `model-metrics.ts` | Yes (≠ judge family) |
| 3 | ≥3-family judge panel, A/B–B/A ordering, multi-dim rubric, **unsupervised** self-consistency calibration, abstention | `panel.ts` + `judges.ts` + `calibration.ts` | Yes |
| 4 | Position / verbosity / self-preference bias probes; subtract coefficients, drop over-biased judges | `bias-probes.ts` | Yes (constructed ground truth) |

`cascade.ts` routes each item deterministic-first; `scorecard.ts` assembles the
reproducible scorecard (JSON + markdown) recording panel composition, the
self-consistency K, the calibration method, and per-judge bias coefficients (§7
provenance).

## Running

```bash
# Hermetic plumbing self-test — deterministic stubs for every tier, no network.
npm run bench:rag-eval -- --fake --samples=3 --datasets=nq

# Real run: gold-QA datasets + offline kb-ask answers + ≥3 live judge families.
npm run bench:rag-eval -- \
  --datasets=hotpotqa,nq \
  --data-dir=benchmarks/.cache/rag-eval \
  --answers=answers.jsonl \
  --judges=judges.json \
  --samples=5
```

### Inputs

- **Gold-QA datasets** — one `<dataset>.jsonl` per registry entry
  (`registry.ts`: `hotpotqa`, `nq`, `2wikimultihop`) under `--data-dir`
  (default `benchmarks/.cache/rag-eval`, gitignored). Each row is
  `{id, question, answer|answers|short_answers, supporting_facts?}`; the loader
  (`dataset.ts`) normalizes the upstream field-name variants.
- **Answers** — `--answers=<jsonl>`, one `{id, answer, contexts}` per line,
  produced offline by `kb ask`. Without it (and without `--fake`) every item is
  recorded *pending* — no fabricated score.
- **Judges** — `--judges=<json>`, an array of
  `{name, family, endpoint, model}` wired over the compiled provider abstraction
  (`src/llm-client.ts`). The RFC requires ≥3 distinct families.

## Honesty contract

The cascade never fabricates a decision. If a downstream tier is not wired (no
NLI/semantic checkpoint, no live judge panel), the items that would route there
stay *pending* and the scorecard states the run is partial. Only tiers that
actually ran contribute numbers. The deterministic Tier 1 carries the weight;
the judge panel only adjudicates the genuinely-subjective residue.

A fully-populated run needs the datasets, an NLI checkpoint, a BERTScore/COMET
model, and ≥3 live judge families — much of which is environment-dependent.
