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
      "chunks": 500,
      "ms": 10761,
      "save_calls": 100,
      "from_texts_calls": 1,
      "add_documents_calls": 99
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

## Stub vs real-provider mode

`BENCH_PROVIDER=stub` is the CI default. In this mode the harness monkey-patches the embedding classes and `FaissStore` at runtime so benchmark runs are deterministic and do not depend on credentials, remote APIs, or FAISS binary portability. The stub vector store still drives the repository's current indexing loop, hash sidecars, and query flow, which lets the benchmark capture current structural costs like per-file saves.

Real-provider modes (`ollama`, `huggingface`, `openai`) keep the repository logic unchanged and measure live embeddings plus the actual FAISS store. Those runs are intended for maintainer-local baselines, not for blocking CI.

## Deterministic fixtures

The benchmark fixtures are generated at bench start from a seeded `mulberry32` PRNG. This keeps the corpus stable across runs while avoiding checked-in FAISS binaries that can break across platforms. The generator lives in `benchmarks/fixtures/generator.ts`.

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
| `--fixture=small\|medium\|external` | `medium` | Synthetic profile; `external` honors `KNOWLEDGE_BASES_ROOT_DIR`. (`large`/arxiv corpus is a follow-up.) |
| `--queries=<path>` | bundled `queries-default.txt` for prose corpora; fixture-derived for synthetic | One query per line; `#`-comments allowed. |
| `--concurrency=1,4,16` | `1,4,16` | Concurrency sweep for the batch-query phase. |
| `--golden=<path>` | none | Reserved — JSON `{query: [doc_paths]}` for recall@k. (Not yet wired into the report; follow-up.) |
| `--output-dir=<path>` | `benchmarks/results` | Where the HTML + JSON pair lands. |
| `--skip-add` | off | Reuse already-registered models (no re-embed). |
| `--yes` | off | Non-interactive; skips paid-provider cost prompt. |

Output:

```
benchmarks/results/compare-<id_a>-vs-<id_b>-<utc-stamp>.html  ← open in any browser
benchmarks/results/compare-<id_a>-vs-<id_b>-<utc-stamp>.json  ← merged input + crossModel + cost
```

The HTML has six sections: summary table (with per-axis winner column), latency-distribution charts (single-query + batch p99 by concurrency), throughput-vs-concurrency line chart, on-disk storage stacked bar, query-level detail (collapsible top-5 per model with overlap highlighting), and a rule-based recommendation panel (fixed thresholds documented inline so a skeptical reader can disagree explicitly). Disclaimers section makes the "your-KB selection guidance, NOT MTEB" framing explicit.

### Auto-clamping fixture chunk size to fit short-context models (#107)

Before driving the bench legs, the orchestrator probes each model's `num_ctx`
and computes a fixture chunk size that fits the smaller of the two, with a
30% safety margin. For Ollama models the probe queries `POST /api/show`
(reading `model_info.<arch>.context_length`); for HuggingFace + OpenAI it
consults a small lookup table covering common defaults — unknown HF/OpenAI
models fall back to a 512-token assumption. Probe failures (Ollama daemon
unreachable, unknown HF model, etc.) log a warning to stderr and fall back to
the same 512-token assumption rather than blocking the run. The chosen value
is propagated to each bench leg via `BENCH_FIXTURE_CHUNK_CHARS`, and the
shared corpus is regenerated with `MarkdownTextSplitter({ chunkSize, chunkOverlap: chunkSize/5 })`.

The orchestrator prints the resolved values on startup so operators can see
why their chunk size shrank between runs:

```
[bench:compare] model A num_ctx=8192, model B num_ctx=256 → chunk_chars=537 (safe for both)
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

Concurrency invariants (RFC 013 §4.13.9):

- Both per-model bench legs run **back-to-back, never in parallel** — avoids CPU/network confounding.
- Cross-model phase mutates `process.env` per leg to load the right manager; safe because the orchestrator never starts the MCP server (no single-instance contention with a user's running MCP).
- Per-model write-locks (RFC 013 §4.6) keep concurrent `kb` invocations on the same `FAISS_INDEX_PATH` safe.

Follow-ups not in M5 v1:

- `--fixture=large` with the ~3000-chunk arxiv (`cs.IR + cs.CL`) corpus and sha256-keyed cache (`benchmarks/.cache/`) — RFC 013 §4.13.4. Today the orchestrator runs against the existing seeded synthetic generator at the bench's hardcoded sizes (~600 chunks for cold-index).
- `--golden` recall@k integration into the report.
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
