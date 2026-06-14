# BEIR full-matrix sweep

Local BEIR matrix run, not an official leaderboard submission. The headline
is the per-mode **multi-domain mean nDCG@10** — averaging across domains is
the anti-overfitting metric (RFC 020 §2/§6).

- Generated: 2026-06-14T22:48:08.823Z
- Commit: `869d527`
- Embedding: ollama / dengcao/Qwen3-Embedding-0.6B:Q8_0
- RRF c=60, rerank=Xenova/ms-marco-MiniLM-L-6-v2 topN=40, chunk=1000/200, contextual=off

## Headline — multi-domain mean nDCG@10

| Mode | datasets | mean nDCG@10 | mean P@10 | mean R@10 |
| --- | ---: | ---: | ---: | ---: |
| lexical | 5/5 | 0.3372 | 0.1023 | 0.4184 |
| late | 2/5 | 0.4226 | 0.1305 | 0.4192 |
| dense | 5/5 | 0.3734 | 0.1095 | 0.4731 |
| hybrid | 5/5 | 0.3893 | 0.1181 | 0.4854 |
| hybrid+late | 4/5 | 0.3271 | 0.0927 | 0.4097 |
| hybrid+rerank | 5/5 | 0.3868 | 0.1210 | 0.4684 |
| hybrid+rerank+contextual | 5/5 | 0.3915 | 0.1247 | 0.4746 |

## Per-(dataset × mode) nDCG@10

| dataset | lexical | late | dense | hybrid | hybrid+late | hybrid+rerank | hybrid+rerank+contextual |
| --- | --- | --- | --- | --- | --- | --- | --- |
| scifact | 0.6690 | 0.5892 | 0.6413 | 0.6897 | 0.5955 | 0.7054 | 0.7083 |
| nfcorpus | 0.3025 | 0.2560 | 0.2457 | 0.3167 | 0.2606 | 0.3528 | 0.3593 |
| fiqa | 0.2282 | ERR | 0.3614 | 0.3447 | 0.1741 | 0.3711 | 0.3740 |
| arguana | 0.3329 | ERR | 0.4630 | 0.4294 | 0.2782 | 0.3325 | 0.3382 |
| scidocs | 0.1537 | ERR | 0.1557 | 0.1659 | ERR | 0.1721 | 0.1778 |

## Per-domain breakdown & Δ_g (generalization, §6)

Δ_g = (seen − unseen) / seen. Seen (tuned): scifact, nfcorpus, fiqa. Unseen (reserved): arguana, scidocs, webis-touche2020.

| Mode | seen mean nDCG@10 | unseen mean nDCG@10 | Δ_g |
| --- | ---: | ---: | ---: |
| lexical | 0.3999 | 0.2433 | +39.16% |
| late | 0.4226 | n/a | n/a |
| dense | 0.4162 | 0.3093 | +25.68% |
| hybrid | 0.4504 | 0.2977 | +33.91% |
| hybrid+late | 0.3434 | 0.2782 | +18.99% |
| hybrid+rerank | 0.4764 | 0.2523 | +47.05% |
| hybrid+rerank+contextual | 0.4805 | 0.2580 | +46.30% |

### lexical — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.3329 | 0.0709 |
| bio-medical | nfcorpus | 0.3025 | 0.2124 |
| finance | fiqa | 0.2282 | 0.0631 |
| scientific citation | scidocs | 0.1537 | 0.0780 |
| scientific fact-checking | scifact | 0.6690 | 0.0870 |

### late — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| bio-medical | nfcorpus | 0.2560 | 0.1839 |
| scientific fact-checking | scifact | 0.5892 | 0.0770 |

### dense — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.4630 | 0.0893 |
| bio-medical | nfcorpus | 0.2457 | 0.1913 |
| finance | fiqa | 0.3614 | 0.0991 |
| scientific citation | scidocs | 0.1557 | 0.0786 |
| scientific fact-checking | scifact | 0.6413 | 0.0893 |

### hybrid — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.4294 | 0.0851 |
| bio-medical | nfcorpus | 0.3167 | 0.2291 |
| finance | fiqa | 0.3447 | 0.0965 |
| scientific citation | scidocs | 0.1659 | 0.0869 |
| scientific fact-checking | scifact | 0.6897 | 0.0927 |

### hybrid+late — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.2782 | 0.0569 |
| bio-medical | nfcorpus | 0.2606 | 0.1876 |
| finance | fiqa | 0.1741 | 0.0481 |
| scientific fact-checking | scifact | 0.5955 | 0.0783 |

### hybrid+rerank — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.3325 | 0.0707 |
| bio-medical | nfcorpus | 0.3528 | 0.2474 |
| finance | fiqa | 0.3711 | 0.1032 |
| scientific citation | scidocs | 0.1721 | 0.0897 |
| scientific fact-checking | scifact | 0.7054 | 0.0940 |

### hybrid+rerank+contextual — per-domain

| Domain | datasets | mean nDCG@10 | mean P@10 |
| --- | --- | ---: | ---: |
| argument retrieval | arguana | 0.3382 | 0.0720 |
| bio-medical | nfcorpus | 0.3593 | 0.2582 |
| finance | fiqa | 0.3740 | 0.1043 |
| scientific citation | scidocs | 0.1778 | 0.0943 |
| scientific fact-checking | scifact | 0.7083 | 0.0947 |

## Contamination notes (§6.6)

| Dataset | known-in-pretraining | qrels | note |
| --- | --- | --- | --- |
| scifact | no | expert | Expert (scientist) claim↔evidence annotations; small corpus, low pretraining-leakage risk. |
| nfcorpus | no | expert | Medical nutrition queries with expert/relevance-graded links; niche corpus, low leakage risk. |
| fiqa | no | crowdsourced | Financial opinion QA over StackExchange/forum text; crowdsourced relevance. |
| arguana | no | crowdsourced | Counter-argument retrieval; query IS a full argument. Distinct task shape from QA — held out for Δ_g. |
| scidocs | no | automatic | Citation/co-read prediction; relevance derived from citation graph (automatic). Held out for Δ_g. |

## Excluded cells (errors — not in any mean)

- `fiqa × late`: cell artifact missing or unreadable: benchmarks/results/beir/matrix/qwen3-q4preface/kb-fiqa-late-source-results.json (ENOENT)
- `arguana × late`: cell artifact missing or unreadable: benchmarks/results/beir/matrix/qwen3-q4preface/kb-arguana-late-source-results.json (ENOENT)
- `scidocs × late`: cell artifact missing or unreadable: benchmarks/results/beir/matrix/qwen3-q4preface/kb-scidocs-late-source-results.json (ENOENT)
- `scidocs × hybrid+late`: cell artifact missing or unreadable: benchmarks/results/beir/matrix/qwen3-q4preface/kb-scidocs-hybrid+late-chunk-results.json (ENOENT)
