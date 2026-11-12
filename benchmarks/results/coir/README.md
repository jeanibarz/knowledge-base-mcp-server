# CoIR code-retrieval baselines (issue #1052)

These are retrieval-quality baselines for code and mixed text+code content. They
use four datasets from CoIR (Code Information Retrieval, arXiv 2407.02883), run
through the same BEIR runner as `../beir/`. CoIR has its own registry,
`COIR_REGISTRY` in `benchmarks/beir/registry.ts`, and is deliberately left out of
the headline BEIR multi-domain mean and its Δ_g partition.

- **Embedding:** `ollama / nomic-embed-text`, with task prefixes on.
- **Chunking:** the default, 1000/200.
- **Metric:** test-split nDCG@10.
- **Runs:** produced from commit `de0f100`; `stackoverflow-qa-hybrid` was produced
  from `af6dcf8`, which adds only this registry and the converter. Each JSON
  records its own `git_sha`, environment and per-query vectors.

## Results

| dataset | task family | lexical | dense | hybrid |
|---|---|---|---|---|
| cosqa | text-to-code | 0.178 | **0.234** | 0.204 |
| codetrans-dl | code-to-code | **0.301** | 0.161 | 0.179 |
| codetrans-contest | code-to-code | 0.594 | 0.497 | **0.606** |
| stackoverflow-qa | hybrid (text + code) | 0.652 | 0.692 | **0.731** |

The best mode depends on the task family:

- **text-to-code** (cosqa): dense wins. A natural-language query shares few
  tokens with the function it describes, so the lexical leg mostly adds noise.
- **code-to-code** (the two codetrans sets): lexical or hybrid wins. Identifiers
  and API names carry over between the paired snippets. On `codetrans-dl`, plain
  lexical is far ahead (0.301, against 0.161 dense): nomic's embeddings do not
  line up TensorFlow and PaddlePaddle snippets.
- **hybrid text + code** (stackoverflow-qa): hybrid is best. This family is
  closest to the notes this tool actually serves.

## Tokenizer A/B: camelCase splitting in BM25

This compares lexical nDCG@10 with identifier splitting in `src/lexical-bm25.ts`
on and off. The "off" arm was a patched build copy and was not committed.

| dataset | split on (shipped) | split off |
|---|---|---|
| codetrans-dl | 0.301 | 0.301 |
| codetrans-contest | 0.594 | 0.536 |
| cosqa | 0.178 | 0.175 |
| stackoverflow-qa | 0.652 | 0.661 |

Splitting helps on cross-language contest code (+0.058). It is neutral or within
noise elsewhere, including a slight dip on stackoverflow-qa. Keep the shipped
default.

## Reproduce

```bash
python3 benchmarks/scripts/fetch_coir_from_hf.py --dataset <name> --split test \
  --cache-dir <dir> --max-query-chars 3000
npm run build && npx tsc -p tsconfig.bench.json
node build/benchmarks/beir/run.js --dataset=<name> --dataset-dir=<dir>/<name> \
  --split=test --mode=<lexical|dense|hybrid> --output-dir=<out>
```

## Deviations and limitations

- **Queries are truncated to 3,000 characters.** Dense and hybrid modes embed the
  query as one unchunked string. Some CoIR code queries exceed nomic's
  2,048-token context, and the provider then rejects them with HTTP 400. The
  runner surfaces that as a misleading "chunk too long" error. Real `kb search`
  queries are far shorter than this, so the truncation only matters for this
  benchmark.
- **`hybrid+rerank` was not run.** The CPU cross-encoder ran for more than 17
  minutes on 180 `codetrans-dl` queries without finishing, because long code
  documents make every pair expensive. The reranker comparison is #1049.
- **Single run on a single machine.** The per-query vectors in each JSON allow a
  paired significance test (`benchmarks/significance.ts`).
