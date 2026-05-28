# Benchmark Harness

The benchmark harness in this directory establishes RFC 007 PR 0.1's baseline without changing retrieval or indexing behavior. It exercises the current `FaissIndexManager` code paths, writes a stable JSON report, and supports a deterministic `stub` mode for CI plus optional real-provider runs for maintainers.

## Running it

Use the default stub provider for CI-safe structural measurements:

```bash
BENCH_PROVIDER=stub npm run bench
```

Run against a real provider locally when you want end-to-end timings:

```bash
BENCH_PROVIDER=ollama npm run bench
BENCH_PROVIDER=huggingface HUGGINGFACE_API_KEY=... npm run bench
BENCH_PROVIDER=openai OPENAI_API_KEY=... npm run bench
```

Optional environment variables:

- `BENCH_RESULTS_PREFIX` changes the output filename prefix. The default is `run`. Use `baseline` when you want a committed baseline file.
- `BENCH_STUB_EMBED_MS_PER_INPUT` changes the stub embedding latency model. The default is `20` milliseconds per document chunk.
- `BENCH_INCLUDE_CLI_SEARCH=1` opts into the issue #284 `cli_search` scenario. It is off by default because each repetition spawns the built `kb` binary as a child process; the cost is what the scenario measures, so it stays heavier than the in-process scenarios.
- `BENCH_CLI_SEARCH_REPETITIONS` sets the per-variant repetition count for `cli_search`. Defaults to 5.
- `BENCH_CLI_SEARCH_PROFILE=matrix` expands `cli_search` from the compact default profile to a broader local matrix across retrieval modes, scopes, formats, grouping, query shapes, and `k` values.

## BEIR/SciFact local retrieval benchmark

`bench:beir` runs a reproducible local BEIR benchmark, starting with SciFact
test. It downloads the BEIR zip to a cache, expands `corpus.jsonl`,
`queries.jsonl`, and `qrels/test.tsv`, converts the corpus into a temporary
KB root, runs the selected `kb` retrieval primitive, and writes three
artifacts:

- metrics JSON with `nDCG@10`, `MAP@100`, `Recall@10`, `Recall@100`, latency
  percentiles, git SHA, dataset checksum/source URL, command, runtime, and
  chunking metadata
- a TREC-format run file for external scoring tools
- a short Markdown report

Lexical mode requires no provider credentials:

```bash
npm run bench:beir -- \
  --dataset=scifact \
  --split=test \
  --mode=lexical \
  --output-dir=/tmp/kb-beir-scifact
```

For a fast deterministic smoke test, limit the query set:

```bash
npm run bench:beir -- \
  --dataset=scifact \
  --split=test \
  --mode=lexical \
  --max-queries=3 \
  --output-dir=/tmp/kb-beir-scifact-smoke
```

The runner uses `LexicalIndex` chunk BM25 and collapses chunk hits to BEIR
document IDs by max chunk score before writing TREC rows. That collapse is
benchmark-only; normal `kb search --mode=lexical` behavior remains chunk-level.
Reports should be described as a **local BEIR/SciFact benchmark**, not an
official BEIR leaderboard result. Optional MLflow logging is not required for
the JSON/TREC artifacts and can be layered in by the separate bench
observability hook.

## Result file naming

Reports are written to `benchmarks/results/` with this naming pattern:

```text
{prefix}-{provider}-node{major}-{os}-{arch}.json
```

Examples:

- `run-stub-node22-linux-x64.json`
- `baseline-openai-node20-darwin-arm64.json`

The file name is intentionally keyed by provider plus the local Node/OS/arch triple so later PRs can compare like-for-like results.

## JSON schema

Every run writes a single JSON object with stable top-level keys:

```json
{
  "version": 1,
  "git_sha": "84c410d",
  "node_version": "v22.14.0",
  "os": "linux",
  "arch": "x64",
  "provider": "stub",
  "scenarios": {
    "cold_start": {
      "fixture_documents": 100,
      "ms": 170.4,
      "rss_bytes": 81195008
    },
    "cold_index": {
      "files": 100,
      "chunks": 600,
      "ms": 12238,
      "save_calls": 1,
      "from_texts_calls": 1,
      "add_documents_calls": 9
    },
    "warm_query": {
      "repetitions": 30,
      "p50_ms": 85.0,
      "p95_ms": 92.0,
      "p99_ms": 104.0
    },
    "memory_peak": {
      "files": 100,
      "chunk_count": 500,
      "rss_bytes": 112459776,
      "heap_used_bytes": 51380224
    },
    "retrieval_quality": {
      "default_fanout_factor": 3,
      "default_loaded_kbs": 5,
      "default_recall_at_10": 0.98,
      "query_count": 50,
      "sweep": [
        {
          "expected_hit_rate_at_10": 0.62,
          "fanout_factor": 1,
          "loaded_kbs": 3,
          "recall_at_10": 0.93
        }
      ]
    }
  }
}
```

The scenario keys stay flat so CI can query them with tools like `jq`, for example:

```bash
jq '.scenarios.warm_query.p50_ms' benchmarks/results/run-stub-node22-linux-x64.json
```

### `cli_search` — phase timings for the real `kb search` CLI (issues #284 and #303)

When `BENCH_INCLUDE_CLI_SEARCH=1` is set, the harness adds a `cli_search` scenario that spawns the built `kb` binary against an offline `fake` model (issue #204) with a pre-built fixture index. The scenario builds two synthetic knowledge bases so scoped `--kb=<name>` and global searches exercise different CLI paths. Each repetition reports an externally measured wall time plus the internal phase timings the CLI emits with `--timing`:

```json
"cli_search": {
  "schema_version": 2,
  "profile": "default",
  "fixture_knowledge_bases": 2,
  "fixture_files": 22,
  "fixture_chunk_count": 114,
  "variants": [
    {
      "variant": "dense-json-global-k10-prose",
      "format": "json",
      "mode": "dense",
      "effective_mode": "dense",
      "scope": "global",
      "query_shape": "prose",
      "k": 10,
      "group_by_source": false,
      "repetitions": 5,
      "wall_p50_ms": 540,
      "wall_p95_ms": 612,
      "wall_p99_ms": 612,
      "phase_percentiles": {
        "process_start_ms": { "samples": 5, "p50_ms": 318, "p95_ms": 340, "p99_ms": 340 },
        "bootstrap_ms": { "samples": 5, "p50_ms": 4, "p95_ms": 6, "p99_ms": 6 },
        "total_ms": { "samples": 5, "p50_ms": 222, "p95_ms": 260, "p99_ms": 260 }
      },
      "process_start_p50_ms": 318,
      "bootstrap_p50_ms": 4,
      "model_resolution_p50_ms": 2,
      "manager_load_p50_ms": 6,
      "index_load_p50_ms": 71,
      "embed_query_p50_ms": 1,
      "faiss_search_p50_ms": 9,
      "post_filter_p50_ms": 0,
      "staleness_p50_ms": 12,
      "cli_total_p50_ms": 222,
      "rss_peak_bytes": 118800384
    }
  ]
}
```

`process_start_p50_ms` is derived per repetition as `wall_ms - cli_total_ms`, i.e. the Node startup + module-import cost incurred BEFORE the CLI's first internal timer fires, plus the formatting / stdout write that happens AFTER the CLI's `total_ms` clock stops. `rss_peak_bytes` is the maximum `VmHWM` observed across repetitions via `/proc/<pid>/status` polling; on non-Linux kernels this field is `null`.

The default profile is compact enough for CI smoke coverage while still distinguishing dense, lexical, hybrid, and auto retrieval; global vs scoped KB search; JSON vs markdown output; grouped source output; prose vs code-like query shapes; and representative `k` values. `phase_percentiles` reports p50/p95/p99 for every timing phase emitted by that variant, including mode-specific phases such as `lexical_search_ms` and `fusion_ms`. The legacy flat p50 fields remain for existing consumers.

Use the broader profile for local reliability runs:

```bash
BENCH_INCLUDE_CLI_SEARCH=1 BENCH_CLI_SEARCH_PROFILE=matrix npm run bench
```

`cli_search` does not run inside `bench:compare`.

## Stub vs real-provider mode

`BENCH_PROVIDER=stub` is the CI default. In this mode the harness monkey-patches the embedding classes and `FaissStore` at runtime so benchmark runs are deterministic and do not depend on credentials, remote APIs, or FAISS binary portability. The stub vector store still drives the repository's current indexing loop, hash sidecars, and query flow, which lets the benchmark capture current structural costs like per-file saves.

Real-provider modes (`ollama`, `huggingface`, `openai`) keep the repository logic unchanged and measure live embeddings plus the actual FAISS store. Those runs are intended for maintainer-local baselines, not for blocking CI.

## Deterministic fixtures

The benchmark fixtures are generated at bench start from a seeded `mulberry32` PRNG. This keeps the corpus stable across runs while avoiding checked-in FAISS binaries that can break across platforms. The generator lives in `benchmarks/fixtures/generator.ts`.

The default `small` and `medium` compare fixtures are CI-safe synthetic corpora. They are intentionally compact and do not write persistent corpus caches.

`--fixture=large` is maintainer-local. It builds a realistic arxiv-style technical corpus under `benchmarks/.cache/large-corpus/<cache-key>/` by default, verifies every cached markdown file plus `queries.json` and `golden.json` with SHA-256 hashes from `MANIFEST.json`, then copies that verified corpus into each temporary benchmark workspace. Set `BENCH_LARGE_CORPUS_CACHE_DIR=/path/to/cache` to keep the cache outside the repository checkout. If the cache cannot be created or verified, the runner fails with setup instructions instead of silently falling back to a smaller fixture.

The large fixture includes labelled judgments for single-hop, multi-hop, exact-token, paraphrase, and near-duplicate queries. When `--fixture=large` is used without `--queries` or `--golden`, `bench:compare` automatically uses the fixture's query set and golden labels so the report includes ranked quality metrics in addition to indexing time, storage, warm query latency, and batch throughput.

## Comparing two embedding models — `bench:compare` (RFC 013 M5)

The `bench:compare` orchestrator drives two back-to-back per-model bench runs against a shared corpus and emits a self-contained HTML comparison report (inline CSS + SVG; no CDN, no JS framework). Use it to pick between two embedding models on **your hardware** without wiring up MTEB.

```bash
# Real providers (the only meaningful mode for selection):
npm run bench:compare -- \
  --models=ollama__nomic-embed-text-latest,huggingface__BAAI-bge-small-en-v1.5 \
  --concurrency=1,4,16

# Stub provider, smoke-test only (jaccard will be 1.0 — same vectors):
BENCH_PROVIDER=stub npm run bench:compare -- \
  --models=stub:bench-stub-A,stub:bench-stub-B \
  --fixture=small --concurrency=1,4
```

Flags (all post `--`):

| Flag | Default | Meaning |
|------|---------|---------|
| `--models=<id_a>,<id_b>` | required | Two `<provider>__<slug>` ids (or `<provider>:<modelName>`). |
| `--fixture=small\|medium\|large\|external` | `medium` | `small`/`medium` use CI-safe synthetic fixtures; `large` uses the cached maintainer-local corpus; `external` honors `KNOWLEDGE_BASES_ROOT_DIR`. |
| `--queries=<path>` | fixture-derived for small/medium; large-corpus queries for large; bundled `queries-default.txt` for external prose corpora | One query per line; `#`-comments allowed. |
| `--concurrency=1,4,16` | `1,4,16` | Concurrency sweep for the batch-query phase. |
| `--golden=<path>` | large fixture labels when `--fixture=large`, otherwise none | JSON `{query: [{source,relevance}]}` for ranked IR metrics. Legacy `{query: [doc_paths]}` arrays are treated as binary labels. |
| `--output-dir=<path>` | `benchmarks/results` | Where the HTML + JSON pair lands. |
| `--skip-add` | off | Reuse already-registered models (no re-embed). |
| `--yes` | off | Non-interactive; skips paid-provider cost prompt. |

Output:

```
benchmarks/results/compare-<id_a>-vs-<id_b>-<utc-stamp>.html  ← open in any browser
benchmarks/results/compare-<id_a>-vs-<id_b>-<utc-stamp>.json  ← merged input + crossModel + cost
```

The HTML has six sections: summary table (with per-axis winner column), latency-distribution charts (single-query + batch p99 by concurrency), throughput-vs-concurrency line chart, on-disk storage stacked bar, query-level detail (collapsible top-5 per model with overlap highlighting), and a rule-based recommendation panel (fixed thresholds documented inline so a skeptical reader can disagree explicitly). Disclaimers section makes the "your-KB selection guidance, NOT MTEB" framing explicit.

## Optional experiment tracking — MLflow

The benchmark JSON and HTML files remain the canonical artifacts. MLflow is an
optional side effect, enabled only when `BENCH_MLFLOW_*` is set. The normal
`npm run bench` and `npm run bench:compare` paths do not import Python or
require the `mlflow` package.

Install the optional Python package when you want tracking:

```bash
python3 -m pip install mlflow
```

Log a plain benchmark run to a local MLflow store:

```bash
BENCH_PROVIDER=stub \
BENCH_MLFLOW_URI=file:///tmp/kb-mlruns \
BENCH_MLFLOW_EXPERIMENT=kb-benchmarks \
npm run bench
```

Log a compare run with tags:

```bash
BENCH_MLFLOW_URI=http://127.0.0.1:5000 \
BENCH_MLFLOW_EXPERIMENT=kb-compare \
BENCH_MLFLOW_TAGS=suite=large,owner=local \
npm run bench:compare -- \
  --models=ollama__nomic-embed-text-latest,huggingface__BAAI-bge-small-en-v1.5 \
  --fixture=large \
  --yes
```

MLflow receives flattened params/metrics plus the benchmark artifacts:

- `npm run bench`: the JSON report.
- `npm run bench:compare`: the merged JSON and self-contained HTML report.

Supported environment variables:

| Variable | Meaning |
|----------|---------|
| `BENCH_MLFLOW_URI` | Tracking URI passed to `mlflow.set_tracking_uri`, e.g. `file:///tmp/kb-mlruns` or `http://host:5000`. |
| `BENCH_MLFLOW_EXPERIMENT` | Experiment name. Defaults to `kb-benchmarks` when any MLflow env is set. |
| `BENCH_MLFLOW_RUN_NAME` | Optional run name. |
| `BENCH_MLFLOW_TAGS` | Comma-separated `key=value` tags. |
| `BENCH_MLFLOW_PYTHON` | Python interpreter to use. Defaults to `python3`. |

If MLflow env is set but the optional package is missing, the run fails with a
setup message rather than silently dropping requested tracking.

## Optional tuning — Optuna

Optuna is also optional. The runner proposes environment-variable values,
executes a benchmark command, reads the JSON artifact printed by that command,
and optimizes the metric dot-path you name. It does not change the benchmark
contract and it does not run unless invoked explicitly.

Install the optional Python package:

```bash
python3 -m pip install optuna
```

Example: minimize warm-query p95 while sweeping fixture chunk size:

```bash
npm run bench:tune -- \
  --trials=20 \
  --direction=minimize \
  --metric=scenarios.warm_query.p95_ms \
  --param-int=BENCH_FIXTURE_CHUNK_CHARS=256:1536:128 \
  -- npm run bench
```

Persist a study so repeated runs resume:

```bash
npm run bench:tune -- \
  --storage=sqlite:///benchmarks/results/kb-optuna.db \
  --study-name=chunk-size-latency \
  --trials=50 \
  --direction=minimize \
  --metric=scenarios.warm_query.p95_ms \
  --param-int=BENCH_FIXTURE_CHUNK_CHARS=256:1536:128 \
  --param-int=BENCH_FIXTURE_CHUNKS_PER_FILE=3:10 \
  -- npm run bench
```

You can combine Optuna with MLflow by exporting `BENCH_MLFLOW_*` before running
`bench:tune`; each trial benchmark logs normally.

Tune BEIR/SciFact lexical chunking against `nDCG@10`:

```bash
npm run bench:tune -- \
  --trials=12 \
  --direction=maximize \
  --metric=metrics.ndcgAt10 \
  --study-name=scifact-lexical \
  --best-config-out=/tmp/kb-scifact-lexical-best.json \
  --param-int=KB_CHUNK_SIZE=256:1024:128 \
  --param-int=KB_CHUNK_OVERLAP=0:128:32 \
  -- npm run bench:beir -- --dataset=scifact --split=test --mode=lexical --max-queries=25 --output-dir=/tmp/kb-scifact-tune
```

The tuner writes a replay config containing the benchmark command and best-trial
environment values. Replaying does not require Optuna:

```bash
npm run bench:tune -- --replay-config=/tmp/kb-scifact-lexical-best.json
```

`bench:beir` also accepts JSON config directly:

```json
{
  "schema_version": "kb.beir-config.v1",
  "env": {
    "KB_CHUNK_SIZE": 512,
    "KB_CHUNK_OVERLAP": 64
  },
  "beir": {
    "dataset": "scifact",
    "split": "test",
    "mode": "lexical",
    "k": 100,
    "chunk_k": 1000
  }
}
```

```bash
npm run bench:beir -- --config=/tmp/kb-beir-config.json --output-dir=/tmp/kb-beir-replay
```

### Auto-clamping fixture chunk size to fit short-context models (#107)

Before driving the bench legs, the orchestrator probes each model's `num_ctx`
and computes a fixture chunk size that fits the smaller of the two, with a
30% safety margin. For Ollama models the probe queries `POST /api/show` and
reads the runtime `num_ctx` out of the `parameters` blob (the value the
daemon enforces at embed time); falling back to
`model_info.<arch>.context_length` only when `parameters` doesn't carry it.
For HuggingFace + OpenAI it consults a small lookup table covering common
defaults — unknown HF/OpenAI models fall back to a 512-token assumption. Probe failures (Ollama daemon
unreachable, unknown HF model, etc.) log a warning to stderr and fall back to
the same 512-token assumption rather than blocking the run. The chosen value
is propagated to each bench leg via two env vars: `BENCH_FIXTURE_CHUNK_CHARS`
controls the size of the synthetic fixture's markdown files, and
`KB_CHUNK_SIZE` controls the production `FaissIndexManager` splitter that
re-chunks those files at embed time. Both must agree, otherwise the
production splitter re-emits 1000-char chunks regardless of fixture file
size and the auto-clamp is moot. The shared corpus is regenerated with
`MarkdownTextSplitter({ chunkSize, chunkOverlap: chunkSize/5 })`.

The orchestrator prints the resolved values on startup so operators can see
why their chunk size shrank between runs:

```
[bench:compare] model A num_ctx=8192, model B num_ctx=256 → chunk_chars=358 (safe for both)
```

This makes `nomic-embed-text` (ctx=8192) vs. `all-minilm` (ctx=256) — and
similar long-vs-short comparisons (`bge-small-en` 512, `mxbai-embed-large`
512, `granite-embedding:30m` 512, `snowflake-arctic-embed:33m` 512) — work
out of the box. Pre-#107 the second leg crashed seven retries deep with
`400 the input length exceeds the context length`.

To override (e.g. for `--fixture=external` against your own KB whose chunks
are already small enough):

```bash
BENCH_FIXTURE_CHUNK_CHARS=1000 npm run bench:compare -- --models=…
```

`BENCH_FIXTURE_FILES=N` and `BENCH_FIXTURE_CHUNKS_PER_FILE=N` are also
honored as scope knobs that override each scenario's hardcoded defaults.

For a maintainer-local large run:

```bash
BENCH_LARGE_CORPUS_CACHE_DIR=/tmp/kb-bench-large-cache \
  npm run bench:compare -- \
  --models=ollama__nomic-embed-text-latest,huggingface__BAAI-bge-small-en-v1.5 \
  --fixture=large \
  --concurrency=1,4,16 \
  --yes
```

The first run populates the deterministic cache; later runs reuse it after integrity verification. Do not commit generated cache contents or compare results unless you are deliberately updating benchmark artifacts.

Concurrency invariants (RFC 013 §4.13.9):

- Both per-model bench legs run **back-to-back, never in parallel** — avoids CPU/network confounding.
- Cross-model phase mutates `process.env` per leg to load the right manager; safe because the orchestrator never starts the MCP server (no single-instance contention with a user's running MCP).
- Per-model write-locks (RFC 013 §4.6) keep concurrent `kb` invocations on the same `FAISS_INDEX_PATH` safe.

Follow-ups not in M5 v1:

- `workflow_dispatch` GitHub workflow for maintainer-triggered real-provider runs (RFC 013 §4.13.7).

## Jest mocking strategy note

The repository's unit tests should keep using the existing Jest ESM mock pattern from [`src/FaissIndexManager.test.ts`](../src/FaissIndexManager.test.ts):

```ts
jest.mock('@langchain/community/vectorstores/faiss', () => ({
  __esModule: true,
  FaissStore: MockFaissStore,
}));
```

That pattern is the right choice for tests because it keeps module replacement explicit and isolated inside Jest. The benchmark harness uses runtime monkey-patching instead because it runs as a plain Node script outside Jest. Do not copy the benchmark patching approach into tests unless the repo's Jest setup changes.
