# BEIR full-matrix sweep

Local BEIR matrix run, not an official leaderboard submission. The headline
is the per-mode **multi-domain mean nDCG@10** — averaging across domains is
the anti-overfitting metric (RFC 020 §2/§6).

- Generated: 2026-06-11T18:23:42.947Z
- Commit: `a4fe7de`
- Embedding: ollama / nomic-embed-text
- RRF c=60, rerank=Xenova/ms-marco-MiniLM-L-6-v2 topN=40, chunk=1000/200, contextual=off

## Headline — multi-domain mean nDCG@10

| Mode | datasets | mean nDCG@10 | mean P@10 | mean R@10 |
| --- | ---: | ---: | ---: | ---: |
| lexical | 5/5 | 0.3372 | 0.1023 | 0.4184 |
| dense | 5/5 | 0.2547 | 0.0715 | 0.3425 |
| hybrid | 5/5 | 0.3204 | 0.0953 | 0.4246 |
| hybrid+rerank | 5/5 | 0.3762 | 0.1136 | 0.4555 |
| late | 2/5 | 0.4226 | 0.1305 | 0.4192 |
| hybrid+late | 5/5 | 0.2853 | 0.0862 | 0.3522 |
| hybrid+rerank+contextual | 3/5 | 0.4579 | 0.1310 | 0.5656 |

## Per-(dataset × mode) nDCG@10

| dataset | lexical | dense | hybrid | hybrid+rerank | late | hybrid+late | hybrid+rerank+contextual |
| --- | --- | --- | --- | --- | --- | --- | --- |
| scifact | 0.6690 | 0.4914 | 0.6109 | 0.7052 | 0.5892 | 0.5965 | 0.7049 |
| nfcorpus | 0.3025 | 0.1799 | 0.2487 | 0.3290 | 0.2560 | 0.2609 | 0.3346 |
| fiqa | 0.2282 | 0.2235 | 0.2526 | 0.3492 | ERR | 0.1731 | ERR |
| arguana | 0.3329 | 0.3231 | 0.3783 | 0.3322 | ERR | 0.2782 | 0.3343 |
| scidocs | 0.1537 | 0.0559 | 0.1113 | 0.1655 | ERR | 0.1179 | ERR |

## Per-domain breakdown & Δ_g (generalization, §6)

Δ_g = (seen − unseen) / seen. Seen (tuned): scifact, nfcorpus, fiqa. Unseen (reserved): arguana, scidocs, webis-touche2020.

| Mode | seen mean nDCG@10 | unseen mean nDCG@10 | Δ_g |
| --- | ---: | ---: | ---: |
| lexical | 0.3999 | 0.2433 | +39.16% |
| dense | 0.2982 | 0.1895 | +36.46% |
| hybrid | 0.3707 | 0.2448 | +33.97% |
| hybrid+rerank | 0.4611 | 0.2488 | +46.04% |
| late | 0.4226 | n/a | n/a |
| hybrid+late | 0.3435 | 0.1981 | +42.34% |
| hybrid+rerank+contextual | 0.5197 | 0.3343 | +35.67% |

### lexical — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.3329 | 0.0709 |
| bio-medical | nfcorpus | 0.3025 | 0.2124 |
| finance | fiqa | 0.2282 | 0.0631 |
| scientific citation | scidocs | 0.1537 | 0.0780 |
| scientific fact-checking | scifact | 0.6690 | 0.0870 |

### dense — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.3231 | 0.0673 |
| bio-medical | nfcorpus | 0.1799 | 0.1269 |
| finance | fiqa | 0.2235 | 0.0654 |
| scientific citation | scidocs | 0.0559 | 0.0285 |
| scientific fact-checking | scifact | 0.4914 | 0.0693 |

### hybrid — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.3783 | 0.0781 |
| bio-medical | nfcorpus | 0.2487 | 0.1765 |
| finance | fiqa | 0.2526 | 0.0742 |
| scientific citation | scidocs | 0.1113 | 0.0625 |
| scientific fact-checking | scifact | 0.6109 | 0.0850 |

### hybrid+rerank — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.3322 | 0.0704 |
| bio-medical | nfcorpus | 0.3290 | 0.2241 |
| finance | fiqa | 0.3492 | 0.0946 |
| scientific citation | scidocs | 0.1655 | 0.0856 |
| scientific fact-checking | scifact | 0.7052 | 0.0930 |

### late — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| bio-medical | nfcorpus | 0.2560 | 0.1839 |
| scientific fact-checking | scifact | 0.5892 | 0.0770 |

### hybrid+late — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.2782 | 0.0569 |
| bio-medical | nfcorpus | 0.2609 | 0.1879 |
| finance | fiqa | 0.1731 | 0.0478 |
| scientific citation | scidocs | 0.1179 | 0.0598 |
| scientific fact-checking | scifact | 0.5965 | 0.0787 |

### hybrid+rerank+contextual — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.3343 | 0.0706 |
| bio-medical | nfcorpus | 0.3346 | 0.2291 |
| scientific fact-checking | scifact | 0.7049 | 0.0933 |

## Contamination notes (§6.6)

| Dataset | known-in-pretraining | qrels | note |
| --- | --- | --- | --- |
| scifact | no | expert | Expert (scientist) claim↔evidence annotations; small corpus, low pretraining-leakage risk. |
| nfcorpus | no | expert | Medical nutrition queries with expert/relevance-graded links; niche corpus, low leakage risk. |
| fiqa | no | crowdsourced | Financial opinion QA over StackExchange/forum text; crowdsourced relevance. |
| arguana | no | crowdsourced | Counter-argument retrieval; query IS a full argument. Distinct task shape from QA — held out for Δ_g. |
| scidocs | no | automatic | Citation/co-read prediction; relevance derived from citation graph (automatic). Held out for Δ_g. |

## Excluded cells (errors — not in any mean)

- `fiqa × late`: cell artifact missing or unreadable: benchmarks/results/beir/matrix/nomic-v2/kb-fiqa-late-source-results.json (ENOENT)
- `arguana × late`: cell artifact missing or unreadable: benchmarks/results/beir/matrix/nomic-v2/kb-arguana-late-source-results.json (ENOENT)
- `scidocs × late`: cell artifact missing or unreadable: benchmarks/results/beir/matrix/nomic-v2/kb-scidocs-late-source-results.json (ENOENT)
- `fiqa × hybrid+rerank+contextual`: cell artifact missing or unreadable: benchmarks/results/beir/matrix/nomic-v2/kb-fiqa-hybrid+rerank+contextual-chunk-results.json (ENOENT)
- `scidocs × hybrid+rerank+contextual`: cell artifact missing or unreadable: benchmarks/results/beir/matrix/nomic-v2/kb-scidocs-hybrid+rerank+contextual-chunk-results.json (ENOENT)
