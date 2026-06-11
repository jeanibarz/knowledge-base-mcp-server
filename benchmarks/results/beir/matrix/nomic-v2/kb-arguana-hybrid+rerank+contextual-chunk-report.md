# BEIR/arguana local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: arguana test
- Mode: hybrid+rerank+contextual (provider: ollama, model: nomic-embed-text, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40, contextual: on)
- Corpus documents: 8674
- Queries evaluated: 1406
- nDCG@10: 0.334337
- precision@10: 0.070626
- MAP@100: 0.233936
- Recall@10: 0.706259
- Recall@100: 0.98293
- Query latency: p50 4986.682748 ms, p95 6577.601584 ms, p99 7239.692597 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-v2/kb-arguana-hybrid+rerank+contextual-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-v2/kb-arguana-hybrid+rerank+contextual-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=arguana --split=test --mode=hybrid+rerank+contextual --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-v2 --preface-cache-dir=/home/jean/.cache/kb-beir-preface-cache/arguana-fip/.contextual-prefaces
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
