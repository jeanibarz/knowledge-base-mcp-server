# End-to-end RAG eval scorecard — human-label-free

Four-tier cascade (RFC 020 §5, milestone M4). No human-annotated labels.

- Datasets: hotpotqa
- Provider/model: ollama / (default)
- Answerer (kb ask LLM): (unset)
- git SHA: 7c48945

## Tier 1 — deterministic reference metrics

| Metric | Value |
| --- | ---: |
| Items | 3 |
| Exact-match | 1.0000 |
| Token-F1 | 1.0000 |
| Context recall | 1.0000 |
| Context precision | 1.0000 |
| Items with gold facts | 3 |

## Cascade routing (deterministic-first)

| Decided by | Items |
| --- | ---: |
| Tier 1 (deterministic) | 3 |
| Tier 2 (NLI + semantic) | 0 |
| Tier 3 (judge panel) | 0 |
| Tier 3 abstained | 0 |
| Pending (tier not wired) | 0 |

## Correctness (scored items only)

- Scored: 3 / 3
- Correct: 3
- Accuracy: 1.0000

## Tier 3 — panel self-consistency confidence

- Distinct judge families: 3 (RFC requires ≥3)
- Self-consistency K: 5
- Calibration: (none)
- Mean self-consistency: —
- Mean calibrated confidence: —
- Abstention rate: —

## Tier 4 — per-judge probe-measured bias coefficients

No bias probes run (judge panel not wired in this run).

## Caveats

- Human-label-free: correctness comes from gold-bearing QA + automated cross-checks (RFC 020 §5), never human annotation.
- Deterministic-first cascade: Tier 1 (gold EM/F1 + context recall/precision) carries the weight; the judge panel only adjudicates the residue.
