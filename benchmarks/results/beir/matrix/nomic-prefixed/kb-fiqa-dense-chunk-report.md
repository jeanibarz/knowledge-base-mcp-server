# BEIR/fiqa local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: fiqa test
- Mode: dense (provider: ollama, model: nomic-embed-text)
- Corpus documents: 57638
- Queries evaluated: 648
- nDCG@10: 0.224005
- precision@10: 0.06358
- MAP@100: 0.185185
- Recall@10: 0.269989
- Recall@100: 0.48072
- Query latency: p50 246.908012 ms, p95 309.440351 ms, p99 340.10344 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-prefixed/kb-fiqa-dense-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-prefixed/kb-fiqa-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=fiqa --split=test --mode=dense --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-prefixed
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
