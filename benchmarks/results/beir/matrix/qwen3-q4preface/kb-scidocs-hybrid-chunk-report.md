# BEIR/scidocs local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scidocs test
- Mode: hybrid (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 25657
- Queries evaluated: 1000
- nDCG@10: 0.165932
- precision@10: 0.0869
- MAP@100: 0.115375
- Recall@10: 0.176467
- Recall@100: 0.413933
- Query latency: p50 3750.618678 ms, p95 5002.079628 ms, p99 8067.492319 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-scidocs-hybrid-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-scidocs-hybrid-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scidocs --split=test --mode=hybrid --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
