# BEIR/scifact local benchmark

This is a local BEIR benchmark run, not an official leaderboard submission.

## Results

- Dataset: scifact test
- Corpus documents: 5183
- Queries evaluated: 300
- nDCG@10: 0.66781
- MAP@100: 0.628277
- Recall@10: 0.790111
- Recall@100: 0.881889
- Query latency: p50 6.554473 ms, p95 11.440852 ms, p99 14.873847 ms

## Artifacts

- Metrics JSON: [results.json](results.json)
- TREC run: [run.trec](run.trec)

## Reproduce

```bash
npm run bench:beir -- --dataset=scifact --split=test --mode=lexical --lexical-unit=document --output-dir=benchmarks/results/beir/scifact-lexical-document-2026-05-28
```

Lexical document mode requires no provider credentials and scores BEIR title+text as documents.
