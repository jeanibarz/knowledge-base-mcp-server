# BEIR/arguana local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: arguana test
- Mode: hybrid+rerank+contextual (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40, contextual: on)
- Corpus documents: 8674
- Queries evaluated: 1406
- nDCG@10: 0.338247
- precision@10: 0.071977
- MAP@100: 0.234991
- Recall@10: 0.719772
- Recall@100: 0.987909
- Query latency: p50 4705.918125 ms, p95 10564.35068 ms, p99 14001.021217 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3-q4preface/kb-arguana-hybrid+rerank+contextual-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3-q4preface/kb-arguana-hybrid+rerank+contextual-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=arguana --split=test --mode=hybrid+rerank+contextual --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3-q4preface --preface-cache-dir=/home/jean/.cache/kb-beir-preface-cache-q4/arguana-fip/.contextual-prefaces
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
