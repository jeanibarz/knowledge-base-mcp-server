# BEIR/nfcorpus local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: nfcorpus test
- Mode: hybrid (provider: ollama, model: nomic-embed-text)
- Corpus documents: 3633
- Queries evaluated: 323
- nDCG@10: 0.248695
- precision@10: 0.176471
- MAP@100: 0.116885
- Recall@10: 0.134809
- Recall@100: 0.258555
- Query latency: p50 532.56952 ms, p95 682.115563 ms, p99 731.211843 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-v2/kb-nfcorpus-hybrid-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-v2/kb-nfcorpus-hybrid-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=nfcorpus --split=test --mode=hybrid --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-v2
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
