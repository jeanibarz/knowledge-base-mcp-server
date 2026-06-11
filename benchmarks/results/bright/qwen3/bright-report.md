# BRIGHT reasoning-intensive retrieval — local report

Local BRIGHT reproduction (RFC 020 §8, M3), not an official leaderboard submission.

- Provider/model: ollama / dengcao/Qwen3-Embedding-0.6B:Q8_0
- Split: test
- Tasks: 2 (biology, economics)
- Modes: dense, hybrid+rerank

## nDCG@10 by task and mode

| task | dense | hybrid+rerank |
| --- | --- | --- |
| biology | 0.1594 | 0.1308 |
| economics | 0.1578 | 0.1309 |
| **mean** | **0.1586** (2) | **0.1309** (2) |

## hybrid+rerank vs dense (Δ nDCG@10)

| task | dense | hybrid+rerank | Δ |
| --- | --- | --- | --- |
| biology | 0.1594 | 0.1308 | -0.0286 |
| economics | 0.1578 | 0.1309 | -0.0269 |
| **mean Δ** |  |  | **-0.0277** |

## Caveats

- Local BRIGHT reproduction, not an official BRIGHT leaderboard submission.
- Per-query excluded_ids are recorded for provenance but not subtracted from the ranking (doc-level scoring is global), so numbers may run slightly optimistic vs the official harness.
- Dense/hybrid retrieval is driven by the production src/ paths, not a benchmark-only reimplementation.
