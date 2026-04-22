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

## Jest mocking strategy note

The repository's unit tests should keep using the existing Jest ESM mock pattern from [`src/FaissIndexManager.test.ts`](../src/FaissIndexManager.test.ts):

```ts
jest.mock('@langchain/community/vectorstores/faiss', () => ({
  __esModule: true,
  FaissStore: MockFaissStore,
}));
```

That pattern is the right choice for tests because it keeps module replacement explicit and isolated inside Jest. The benchmark harness uses runtime monkey-patching instead because it runs as a plain Node script outside Jest. Do not copy the benchmark patching approach into tests unless the repo's Jest setup changes.
