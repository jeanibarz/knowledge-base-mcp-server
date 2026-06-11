# BEIR/scifact local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scifact test
- Mode: hybrid+rerank+contextual (provider: ollama, model: nomic-embed-text, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40, contextual: on)
- Corpus documents: 5183
- Queries evaluated: 300
- nDCG@10: 0.704885
- precision@10: 0.093333
- MAP@100: 0.66179
- Recall@10: 0.835111
- Recall@100: 0.931333
- Query latency: p50 4162.978828 ms, p95 5660.612677 ms, p99 7996.882501 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/nomic-v2/kb-scifact-hybrid+rerank+contextual-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/nomic-v2/kb-scifact-hybrid+rerank+contextual-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scifact --split=test --mode=hybrid+rerank+contextual --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic-v2 --preface-cache-dir=/home/jean/.cache/kb-beir-preface-cache/scifact-fip/.contextual-prefaces
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
