# BEIR/nfcorpus local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: nfcorpus test
- Mode: hybrid+rerank+contextual (provider: ollama, model: nomic-embed-text, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40, contextual: on)
- Corpus documents: 3633
- Queries evaluated: 323
- nDCG@10: 0.334599
- precision@10: 0.229102
- MAP@100: 0.146574
- Recall@10: 0.155294
- Recall@100: 0.258425
- Query latency: p50 2512.212768 ms, p95 2943.608859 ms, p99 3110.148141 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-v2/kb-nfcorpus-hybrid+rerank+contextual-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-v2/kb-nfcorpus-hybrid+rerank+contextual-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=nfcorpus --split=test --mode=hybrid+rerank+contextual --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-v2 --preface-cache-dir=/home/jean/.cache/kb-beir-preface-cache/nfcorpus-fip/.contextual-prefaces
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
