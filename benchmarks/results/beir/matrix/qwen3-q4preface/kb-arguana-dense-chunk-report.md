# BEIR/arguana local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: arguana test
- Mode: dense (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 8674
- Queries evaluated: 1406
- nDCG@10: 0.462959
- precision@10: 0.089331
- MAP@100: 0.328698
- Recall@10: 0.893314
- Recall@100: 0.990754
- Query latency: p50 495.890902 ms, p95 650.833332 ms, p99 757.876771 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-arguana-dense-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-arguana-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=arguana --split=test --mode=dense --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
