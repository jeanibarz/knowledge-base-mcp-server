# BEIR/fiqa local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: fiqa test
- Mode: hybrid (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 57638
- Queries evaluated: 648
- nDCG@10: 0.344712
- precision@10: 0.096451
- MAP@100: 0.286764
- Recall@10: 0.419028
- Recall@100: 0.702286
- Query latency: p50 11072.11581 ms, p95 22200.275153 ms, p99 29418.66578 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-fiqa-hybrid-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-fiqa-hybrid-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=fiqa --split=test --mode=hybrid --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
