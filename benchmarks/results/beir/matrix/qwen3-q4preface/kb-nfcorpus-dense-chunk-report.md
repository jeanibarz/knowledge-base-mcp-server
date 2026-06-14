# BEIR/nfcorpus local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: nfcorpus test
- Mode: dense (provider: ollama, model: dengcao/Qwen3-Embedding-0.6B:Q8_0)
- Corpus documents: 3633
- Queries evaluated: 323
- nDCG@10: 0.245746
- precision@10: 0.191331
- MAP@100: 0.091071
- Recall@10: 0.104055
- Recall@100: 0.256916
- Query latency: p50 445.29688 ms, p95 534.444936 ms, p99 593.192754 ms

## Artifacts

- Metrics JSON: benchmarks/results/beir/matrix/qwen3/kb-nfcorpus-dense-chunk-results.json
- TREC run: benchmarks/results/beir/matrix/qwen3/kb-nfcorpus-dense-chunk-run.trec

## Reproduce

```bash
node build/benchmarks/beir/run.js --dataset=nfcorpus --split=test --mode=dense --provider=ollama --model=dengcao/Qwen3-Embedding-0.6B:Q8_0 --output-dir=benchmarks/results/beir/matrix/qwen3
```

Dense/hybrid modes drive the production src/ retrieval path (FaissIndexManager + src/hybrid-retrieval RRF). The runner builds a temporary KB corpus, indexes it with the configured embedding provider, and maps kb hits to BEIR document IDs for scoring.
