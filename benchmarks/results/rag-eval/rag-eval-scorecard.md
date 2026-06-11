# End-to-end RAG eval scorecard — human-label-free

Four-tier cascade (RFC 020 §5, milestone M4). No human-annotated labels.

- Datasets: hotpotqa
- Provider/model: ollama / dengcao/Qwen3-Embedding-0.6B:Q8_0
- Answerer (kb ask LLM): deepseek/deepseek-v4-flash
- git SHA: 0c4ffba

## Tier 1 — deterministic reference metrics

| Metric | Value |
| --- | ---: |
| Items | 80 |
| Exact-match | 0.0000 |
| Token-F1 | 0.0679 |
| Context recall | 0.4904 |
| Context precision | 0.1520 |
| Items with gold facts | 80 |

## Cascade routing (deterministic-first)

| Decided by | Items |
| --- | ---: |
| Tier 1 (deterministic) | 0 |
| Tier 2 (NLI + semantic) | 0 |
| Tier 3 (judge panel) | 80 |
| Tier 3 abstained | 0 |
| Pending (tier not wired) | 0 |

## Correctness (scored items only)

- Scored: 80 / 80
- Correct: 80
- Accuracy: 1.0000

## Tier 3 — panel self-consistency confidence

- Distinct judge families: 3 (RFC requires ≥3)
- Self-consistency K: 2
- Calibration: isotonic
- Mean self-consistency: 0.9740
- Mean calibrated confidence: 0.9716
- Abstention rate: 0.0000

## Tier 4 — per-judge probe-measured bias coefficients

| Judge | Family | Position flip | Verbosity | Self-pref | Bias coef | Dropped |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| deepseek-v4-flash-judge | deepseek | 0.0000 | -0.0111 | +0.0000 | +0.0000 | no |
| llama-3.3-70b-judge | llama3 | 0.0000 | -0.0333 | +0.0000 | +0.0000 | no |
| gemma3-4b-local-judge | gemma3 | 0.0000 | +0.0000 | +0.0000 | +0.0000 | no |

## Caveats

- Human-label-free: correctness comes from gold-bearing QA + automated cross-checks (RFC 020 §5), never human annotation.
- Deterministic-first cascade: Tier 1 (gold EM/F1 + context recall/precision) carries the weight; the judge panel only adjudicates the residue.
