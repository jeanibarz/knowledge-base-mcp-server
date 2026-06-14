# BEIR/scifact local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scifact test
- Mode: hybrid+rerank+contextual (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40, contextual: on)
- Corpus documents: 5183
- Queries evaluated: 300
- nDCG@10: 0.708251
- precision@10: 0.094667
- MAP@100: 0.665536
- Recall@10: 0.840778
- Recall@100: 0.948333
- Query latency: p50 1722.064665 ms, p95 2073.889188 ms, p99 4148.539162 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3-q4preface/kb-scifact-hybrid+rerank+contextual-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3-q4preface/kb-scifact-hybrid+rerank+contextual-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=scifact --split=test --mode=hybrid+rerank+contextual --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3-q4preface --preface-cache-dir=/home/jean/.cache/kb-beir-preface-cache-q4/scifact-fip/.contextual-prefaces
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
