# CoIR code-retrieval baselines (issue #1052) — PARTIAL

Test split nDCG@10, `ollama / nomic-embed-text`, default chunking 1000/200, from commit de0f100 + the uncommitted registry/converter in this branch.
Data: `python3 benchmarks/scripts/fetch_coir_from_hf.py --dataset <name> --split test --cache-dir <dir> --max-query-chars 3000`, then
`node build/benchmarks/beir/run.js --dataset=<name> --dataset-dir=<dir>/<name> --split=test --mode=<mode> --output-dir=<out>`.

| dataset | family | lexical | dense | hybrid |
|---|---|---|---|---|
| cosqa | text-to-code | 0.178 | 0.234 | 0.204 |\n| codetrans-dl | code-to-code | 0.301 | 0.161 | 0.179 |\n| codetrans-contest | code-to-code | 0.594 | 0.497 | 0.606 |\n| stackoverflow-qa | hybrid | 0.652 | 0.692 | pending |

Per-family: text-to-code (cosqa) favours dense; code-to-code (codetrans-*) favours lexical/hybrid; stackoverflow-qa (hybrid text+code) favours dense.

## Deviations
- Queries are truncated to 3000 chars: dense/hybrid embed a query unchunked, and longer code queries exceed nomic's 2048-token context (provider 400, surfaced as a misleading "chunk too long" error). Follow-up issue to file.
- `hybrid+rerank` NOT run: >17 min on 180 codetrans-dl queries with no result (CPU cross-encoder on long code).
- stackoverflow-qa hybrid was still running when this was written.

## camelCase tokenizer A/B (lexical nDCG@10, split on vs off; off = patched build copy)
| dataset | on | off |
|---|---|---|
| codetrans-dl | 0.301 | 0.301 |
| codetrans-contest | 0.594 | 0.536 |
| cosqa | 0.178 | 0.175 |
| stackoverflow-qa | 0.652 | 0.661 |
Splitting helps on code-to-code contest data, is neutral elsewhere, and slightly hurts stackoverflow-qa.
