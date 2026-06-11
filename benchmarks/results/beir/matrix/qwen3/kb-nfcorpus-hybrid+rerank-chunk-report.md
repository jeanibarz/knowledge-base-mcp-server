# BEIR/nfcorpus local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: nfcorpus test
- Mode: hybrid+rerank (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0, rerank: Xenova/ms-marco-MiniLM-L-6-v2 topN=40)
- Corpus documents: 3633
- Queries evaluated: 323
- nDCG@10: 0.352786
- precision@10: 0.247368
- MAP@100: 0.161581
- Recall@10: 0.170148
- Recall@100: 0.29846
- Query latency: p50 2038.501277 ms, p95 2493.844313 ms, p99 2751.212485 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-nfcorpus-hybrid+rerank-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-nfcorpus-hybrid+rerank-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=nfcorpus --split=test --mode=hybrid+rerank --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
