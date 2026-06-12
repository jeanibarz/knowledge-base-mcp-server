# BEIR/fiqa local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: fiqa test
- Mode: hybrid (provider: ollama, model: nomic-embed-text)
- Corpus documents: 57638
- Queries evaluated: 648
- nDCG@10: 0.25855
- precision@10: 0.074074
- MAP@100: 0.209976
- Recall@10: 0.32813
- Recall@100: 0.592828
- Query latency: p50 5456.415161 ms, p95 5887.016549 ms, p99 6220.764341 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-prefixed/kb-fiqa-hybrid-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-prefixed/kb-fiqa-hybrid-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=fiqa --split=test --mode=hybrid --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-prefixed
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
