# Reproducing the dense / small-model public-benchmark numbers

This is the end-to-end runbook for reproducing the committed **dense / small-model**
public-benchmark numbers `kb` publishes: the BEIR `(dataset × mode)` matrix, the
MTEB embedding-model rank, and the BRIGHT reasoning-intensive comparison — all
with the small local embedding model `nomic-embed-text` served by Ollama.

It walks from a clean machine to reproduced numbers in ordered steps. The
individual `bench:*` commands and their flags, dataset fetchers, and expected
numbers already live in [benchmarks/README.md](README.md) and
[benchmarks/results/README.md](results/README.md); this page chains them into one
flow so an external reader can verify the numbers without reconstructing it from
several sections.

These are **local reproducible runs, not official leaderboard submissions.** The
quoted numbers are hardware- and runtime-sensitive **reference values**, not
pass/fail thresholds — see [Interpreting the numbers](#interpreting-the-numbers).

---

## What you will reproduce

| Benchmark | Command family | Model | Headline number (reference) |
| --- | --- | --- | --- |
| BEIR matrix | `bench:beir:matrix` / `bench:reproduce --full` | `nomic-embed-text` | dense multi-domain mean nDCG@10 ≈ **0.2547** |
| MTEB rank | `bench:mteb` | `nomic-embed-text` | mean main score ≈ **0.3531** |
| BRIGHT | `bench:bright` | `nomic-embed-text` | dense mean nDCG@10 ≈ **0.1476** |

Terms used below: **nDCG@10** scores how well the top 10 results are ranked (0 to
1, higher is better). **lexical** is keyword (BM25) search; **dense** is
embedding-similarity search; **hybrid** fuses the two with reciprocal rank fusion
(RRF); **+rerank** re-scores the top candidates with a cross-encoder model. A
**reference value** is a number we measured on our hardware that yours should land
*near* — not a pass/fail threshold.

The committed artifacts these numbers come from:

- BEIR matrix — [results/beir/matrix/nomic/beir-matrix.md](results/beir/matrix/nomic/beir-matrix.md)
- MTEB — [results/mteb/nomic.json](results/mteb/nomic.json)
- BRIGHT — [results/bright/nomic/bright-report.md](results/bright/nomic/bright-report.md)

The BEIR per-cell result JSONs record the exact `command`, git SHA, dataset
checksum, and runtime versions that produced them; the MTEB artifact records its
model, tool version, and per-task scores, and the BRIGHT report records its model,
git SHA, and per-task scores. The commands below match those recorded `command`
fields where present.

---

## Step 1 — Prerequisites

The committed runs were produced on Linux x64 with **Node `v24.11.1`** and
**Python `3.10.12`**. Any Node `>= 20` and Python `>= 3.10` should work. The
datasets are content-checksummed (each result JSON records the checksum), so those
are pinned; the `nomic-embed-text` model is pulled by its Ollama tag and is **not**
digest-pinned, so a small drift from a newer model build — on top of the usual
hardware sensitivity — is expected.

1. **Clone and install** the repository dependencies:

   ```bash
   git clone https://github.com/jeanibarz/knowledge-base-mcp-server.git
   cd knowledge-base-mcp-server
   npm ci
   ```

2. **Install [Ollama](https://ollama.com)** and pull the small embedding model.
   The dense/hybrid/reranked modes drive the production embedding path, so a real
   provider is required (the deterministic `fake` provider is plumbing-only — see
   [Step 2](#step-2--fast-offline-smoke-check-no-provider)):

   ```bash
   # Start the Ollama daemon (foreground; or run it as a service):
   ollama serve

   # In another shell, pull the model the committed runs used:
   ollama pull nomic-embed-text
   ```

   Confirm it is served at the default endpoint `http://localhost:11434`.

3. **Install the optional Python packages** for MTEB and the Hugging Face dataset
   fetchers (only needed for the MTEB and BRIGHT steps):

   ```bash
   python3 -m pip install mteb datasets pandas
   ```

---

## Step 2 — Fast offline smoke check (no provider)

Before spending real compute, confirm the dense retrieval path builds and runs
end to end. `bench:reproduce` (default mode) runs `--mode=dense` against the
committed gate fixture with the deterministic `fake` provider — **offline,
credential-free, and fast**:

```bash
npm run bench:reproduce
```

This proves the pipeline works. **The fake-provider numbers are self-test smoke
only, never a quality baseline** — they have no semantic geometry. Reproducing
the real published numbers is the full run in Step 3.

---

## Step 3 — BEIR matrix (dense / nomic)

The BEIR matrix is the headline pipeline result: the per-mode **multi-domain mean
nDCG@10** across five datasets. Averaging across five different domains keeps any
single dataset from dominating the score, so it is the anti-overfitting metric the
project quotes (RFC 020 §2/§6).

### 3a — One-command path

`bench:reproduce --full` composes the canonical dense/nomic flow over the exact
published dataset set (`scifact`, `nfcorpus`, `fiqa`, `arguana`, `scidocs`). It
needs the Ollama daemon from Step 1 with `nomic-embed-text` pulled, and network
egress to download the datasets on first run:

```bash
npm run bench:reproduce -- --full
```

Artifacts land in a temp dir (printed on completion) so a run never dirties the
committed tree. This reproduces only the **dense** slice.

Choose the path that fits: **3a** for a quick dense-only check with one command;
**3b** to reproduce all modes and the aggregate `beir-matrix.json` that the
committed tree holds. If 3a's automatic dataset download fails (the built-in host
is not always reachable), run 3b's dataset-fetch loop first — the runner reuses a
populated cache without re-downloading.

### 3b — Full matrix (all modes)

First pre-populate the dataset cache from the Hugging Face mirror (the runner's
built-in dataset host is not always reachable; a pre-populated cache is reused
without re-downloading):

```bash
# Use an explicit absolute cache dir. Do NOT write `--cache-dir=~/...`: bash does
# not expand `~` after `=` in a normal argument, so the runner would receive a
# literal `~` path. `$HOME` always expands.
CACHE_DIR="$HOME/.cache/kb-beir-cache"

for d in scifact nfcorpus fiqa arguana scidocs; do
  python3 benchmarks/scripts/fetch_beir_from_hf.py \
    --dataset "$d" --split test --cache-dir "$CACHE_DIR"
done
```

Then run the full sweep with the committed flags:

```bash
npm run bench:beir:matrix -- \
  --provider=ollama --model=nomic-embed-text \
  --datasets=scifact,nfcorpus,fiqa,arguana,scidocs \
  --modes=lexical,dense,hybrid,hybrid+rerank \
  --cache-dir "$CACHE_DIR" \
  --output-dir=/tmp/kb-beir-matrix-nomic
```

Under the hood `bench:beir:matrix` builds and then invokes the BEIR runner once
per `(dataset × mode)` cell. Each cell's recorded `command` field is what the doc
matches — you run the `npm run` command above, not this internal invocation. The
committed SciFact dense cell recorded:

```text
node build/benchmarks/beir/run.js --dataset=scifact --split=test --mode=dense \
  --provider=ollama --model=nomic-embed-text --output-dir=benchmarks/results/beir/matrix/nomic
```

Its `--output-dir` differs from yours on purpose: the committed run wrote into the
version-controlled results tree; your `--output-dir=/tmp/...` above keeps the
verification run out of it.

Output: `beir-matrix.{json,md}` plus per-`(dataset × mode)` artifacts in the
output dir.

### Expected numbers (reference)

Committed run env: git `04f3eb8`, RRF `c=60`, rerank `Xenova/ms-marco-MiniLM-L-6-v2`
`topN=40`, chunk `1000/200` (1000-character chunks, 200-character overlap),
contextual off.

Multi-domain mean nDCG@10 by mode:

| Mode | mean nDCG@10 |
| --- | ---: |
| lexical | 0.3372 |
| dense | 0.2547 |
| hybrid | 0.3204 |
| hybrid+rerank | 0.3762 |

Per-`(dataset × mode)` dense nDCG@10:

| dataset | dense nDCG@10 |
| --- | ---: |
| scifact | 0.4914 |
| nfcorpus | 0.1799 |
| fiqa | 0.2235 |
| arguana | 0.3231 |
| scidocs | 0.0559 |

---

## Step 4 — MTEB embedding-model rank (nomic)

MTEB ranks the **embedding model**, not the retrieval pipeline. It runs the
official `mteb` package against the served model:

```bash
# 1. Score the served nomic model with the official mteb package.
python3 benchmarks/mteb_submit.py \
  --provider=ollama \
  --tasks=SciFact,NFCorpus \
  --source=kb-endpoint \
  --embedding-endpoint=http://localhost:11434/v1 \
  --output=/tmp/mteb-nomic.json

# 2. Fold the result into the canonical record + markdown report.
npm run bench:mteb -- --result=/tmp/mteb-nomic.json --provider=ollama
```

`--source=kb-endpoint` ranks the exact served model the product ships. No score
is fabricated: with no `mteb` package or no served model, the recorder produces a
*pending* record that says so.

### Expected numbers (reference)

From [results/mteb/nomic.json](results/mteb/nomic.json) (`mteb` version `1.19.10`):

| Task | main score |
| --- | ---: |
| SciFact | 0.52408 |
| NFCorpus | 0.18203 |
| **mean main score** | **0.353055** |

---

## Step 5 — BRIGHT reasoning-intensive retrieval (nomic)

BRIGHT compares `dense` against `hybrid+rerank` on reasoning-intensive queries —
the setting where reranking is expected to help most. With this small model the
result is mixed (rerank wins on economics but loses on biology and on the two-task
mean, per the table below), which is itself a faithful, reproducible finding. First
export the BRIGHT tasks from Hugging Face into the layout the loader expects:

```bash
python3 benchmarks/scripts/fetch_bright_from_hf.py \
  --tasks biology,economics \
  --bright-dir benchmarks/.cache/bright
```

Then run the headline comparison with the committed flags:

```bash
npm run bench:bright -- \
  --bright-dir=benchmarks/.cache/bright \
  --tasks=biology,economics \
  --modes=dense,hybrid+rerank \
  --provider=ollama --model=nomic-embed-text
```

Output: `benchmarks/results/bright/bright-report.{json,md}` (compare it against the
committed [results/bright/nomic/bright-report.md](results/bright/nomic/bright-report.md)).

### Expected numbers (reference)

From [results/bright/nomic/bright-report.md](results/bright/nomic/bright-report.md)
(git `abe8012`), nDCG@10 by task and mode:

| task | dense | hybrid+rerank |
| --- | ---: | ---: |
| biology | 0.1767 | 0.1322 |
| economics | 0.1185 | 0.1263 |
| **mean** | **0.1476** | **0.1293** |

BRIGHT records per-query `excluded_ids` for provenance but does not subtract them
from the global doc-level ranking, so numbers may run slightly optimistic versus
the official BRIGHT harness. See [bright/README.md](bright/README.md).

---

## Interpreting the numbers

- **These are reference values, not pass/fail thresholds.** They were produced on
  specific hardware, a specific model quantization, and pinned datasets. Small
  drifts in nDCG@10 across machines are expected; a large drift (or a mode that
  ranks out of order — e.g. `hybrid+rerank` below `lexical` on the mean) is the
  signal worth investigating.
- **The mechanical pass/fail gate is separate.** `bench:beir:quality-gate`
  compares fresh nDCG@10 against committed baselines with a tolerance band and a
  significance test (lexical always; dense via the deterministic `fake`
  provider). See [benchmarks/README.md](README.md) → "CI quality gate".
- **The artifacts are self-describing.** The BEIR per-cell result JSONs record git
  SHA, dataset checksum, command, runtime versions, and chunking config; the MTEB
  artifact records its model and tool version, and the BRIGHT report its model and
  git SHA. Any number can be traced back to the artifact that produced it.
- **Nothing here is an official submission.** All numbers are local reproductions
  until the runner is validated against the official BEIR/MTEB/BRIGHT tooling and
  submission workflows.
