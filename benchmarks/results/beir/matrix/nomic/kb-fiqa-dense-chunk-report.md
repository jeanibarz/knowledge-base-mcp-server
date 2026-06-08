# BEIR/fiqa local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: fiqa test
- Mode: dense (provider: ollama, model: nomic-embed-text)
- Corpus documents: 57638
- Queries evaluated: 648
- nDCG@10: 0.223463
- precision@10: 0.065432
- MAP@100: 0.183585
- Recall@10: 0.275436
- Recall@100: 0.484685
- Query latency: p50 263.15189 ms, p95 318.721078 ms, p99 371.72505 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic/kb-fiqa-dense-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic/kb-fiqa-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=fiqa --split=test --mode=dense --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
