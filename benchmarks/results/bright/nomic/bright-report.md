# BRIGHT reasoning-intensive retrieval — local report

Local BRIGHT reproduction (RFC 020 §8, M3), not an official leaderboard submission.

- Provider/model: ollama / nomic-embed-text
- Split: test
- Tasks: 2 (biology, economics)
- Modes: dense, hybrid+rerank

## nDCG@10 by task and mode

| task | dense | hybrid+rerank |
| --- | --- | --- |
| biology | 0.1767 | 0.1322 |
| economics | 0.1185 | 0.1263 |
| **mean** | **0.1476** (2) | **0.1293** (2) |

## hybrid+rerank vs dense (Δ nDCG@10)

| task | dense | hybrid+rerank | Δ |
| --- | --- | --- | --- |
| biology | 0.1767 | 0.1322 | -0.0445 |
| economics | 0.1185 | 0.1263 | +0.0079 |
| **mean Δ** |  |  | **-0.0183** |

## Caveats

- Local BRIGHT reproduction, not an official BRIGHT leaderboard submission.
- Per-query excluded_ids are recorded for provenance but not subtracted from the ranking (doc-level scoring is global), so numbers may run slightly optimistic vs the official harness.
- Dense/hybrid retrieval is driven by the production src/ paths, not a benchmark-only reimplementation.
