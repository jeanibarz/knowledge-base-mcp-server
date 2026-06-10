# BEIR/nfcorpus local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: nfcorpus test
- Mode: hybrid (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 3633
- Queries evaluated: 323
- nDCG@10: 0.316737
- precision@10: 0.229102
- MAP@100: 0.142871
- Recall@10: 0.159454
- Recall@100: 0.29846
- Query latency: p50 597.858417 ms, p95 716.409447 ms, p99 763.953351 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-nfcorpus-hybrid-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-nfcorpus-hybrid-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=nfcorpus --split=test --mode=hybrid --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
