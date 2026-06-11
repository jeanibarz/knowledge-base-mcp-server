# BEIR/nfcorpus local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: nfcorpus test
- Mode: hybrid+rerank (provider: ollama, model: nomic-embed-text, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40)
- Corpus documents: 3633
- Queries evaluated: 323
- nDCG@10: 0.32896
- precision@10: 0.224149
- MAP@100: 0.144832
- Recall@10: 0.1516
- Recall@100: 0.258555
- Query latency: p50 2108.285933 ms, p95 2602.289697 ms, p99 2813.141666 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic/kb-nfcorpus-hybrid+rerank-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic/kb-nfcorpus-hybrid+rerank-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=nfcorpus --split=test --mode=hybrid+rerank --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
