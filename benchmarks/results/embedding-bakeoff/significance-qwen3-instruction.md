## Retrieval significance comparison (family)

Correction: holm across 10 comparison(s) at α=0.05

| Comparison | n | Mean Δ | raw p | adj p | Verdict |
| --- | ---: | ---: | ---: | ---: | --- |
| qwen3+instruction vs qwen3 dense (scifact) | 300 | +0.0629 | <0.0001 | <0.0001 | IMPROVEMENT |
| qwen3+instruction vs qwen3 dense (nfcorpus) | 323 | +0.1159 | <0.0001 | <0.0001 | IMPROVEMENT |
| qwen3+instruction vs qwen3 dense (arguana) | 1406 | +0.0011 | 0.5459 | 1.0000 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| qwen3+instruction vs qwen3 hybrid (scifact) | 300 | +0.0216 | 0.0111 | 0.0665 | NO-SIGNIFICANT-CHANGE |
| qwen3+instruction vs qwen3 hybrid (nfcorpus) | 323 | +0.0420 | <0.0001 | <0.0001 | IMPROVEMENT |
| qwen3+instruction vs qwen3 hybrid (arguana) | 300 | -0.0020 | 0.5227 | 1.0000 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| qwen3+instruction vs nomic dense (scifact) | 300 | +0.0029 | 0.8202 | 1.0000 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| qwen3+instruction vs nomic dense (nfcorpus) | 323 | +0.0123 | 0.0851 | 0.3402 | INCONCLUSIVE-BELOW-NOISE-FLOOR |
| qwen3+instruction vs nomic dense (arguana) | 1406 | +0.0908 | <0.0001 | <0.0001 | IMPROVEMENT |
| qwen3+instruction vs mxbai-embed-large dense (nfcorpus) | 323 | -0.0186 | 0.0450 | 0.2250 | NO-SIGNIFICANT-CHANGE |

Non-significant rows are reported, not failed (RFC 020 §3/§4).
