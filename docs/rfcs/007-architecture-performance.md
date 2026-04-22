# RFC 007 — Architecture clean-up and performance benchmarks

- **Status:** Draft — awaiting approval
- **Author:** Jean Ibarz (drafted by automation)
- **Target:** `jeanibarz/knowledge-base-mcp-server` `main`
- **Related:** RFC 005 (code quality), RFC 006 (retrieval)

## 1. Summary

The server has no performance baseline. Every `retrieve_knowledge` call re-walks every file in every knowledge base, re-hashes them, and for any changed file invokes the embedding provider and serializes the whole FAISS index to disk — synchronously and one file at a time. With a 100-file / ~500-chunk synthetic KB, a cold build takes ~10.8 s (dominated by 500 serial embedding round-trips and 100 FAISS saves), and a warm no-op query still pays ~85 ms of filesystem/scan overhead before any search happens. This RFC proposes (a) a checked-in benchmark harness, (b) four targeted refactors (batched embeddings, save-once, lazy-scan, per-KB indexes), and (c) an opt-in regression gate.

## 2. Motivation

### 2.1 Evidence from code

- `handleRetrieveKnowledge` runs `this.faissManager.updateIndex(knowledge_base_name)` on **every** retrieval call — see `src/KnowledgeBaseServer.ts:84`. The request path therefore pays a full filesystem scan before the search can begin.
- `FaissIndexManager.updateIndex` iterates files serially (`src/FaissIndexManager.ts:190`, `src/FaissIndexManager.ts:198`) and calls `addDocuments` + `save` **inside** that loop (`src/FaissIndexManager.ts:259`, `src/FaissIndexManager.ts:263`). For N changed files, that is N sequential embedding round-trips and N full-index serializations.
- `FaissStore.fromTexts` / `addDocuments` are called per-file with only that file's chunks (`src/FaissIndexManager.ts:253`, `src/FaissIndexManager.ts:259`), preventing batch-embedding amortization.
- There is a single process-wide FAISS index (`src/FaissIndexManager.ts:66`) that mixes documents from every knowledge base. A query that scopes to one KB still loads and keeps in memory every other KB's vectors.
- `updateIndex` reads the **entire** file into memory twice per unchanged file — once via `calculateSHA256` (`src/utils.ts:6-11`) and once via `fsp.readFile` (`src/FaissIndexManager.ts:216`, `src/FaissIndexManager.ts:227`). The hash path has no short-circuit based on `mtime`/`size`.
- Four `fs.existsSync` calls (`src/FaissIndexManager.ts:112`, `:130`, `:141`, `:206`) block the event loop inside otherwise async flows.
- The on-disk flow doc (`src/knowledge-base-server-flow.md`) is stale: it references "GCP Credentials", "Initialize OpenAI Embeddings", and a "Stubbed Similarity Search" — none of which match the current code. Future maintainers relying on it will be misled.

### 2.2 Evidence from README

The README (`README.md:171-184`) promises:

> "The FAISS index is automatically initialized when the server starts. It checks for changes in the knowledge base files and updates the index accordingly."

The current implementation only re-checks files during retrieval, not at startup, and the check is O(files-across-all-KBs) on every call. No doc sets user expectations for how this scales.

### 2.3 Prior-art signals

Past PRs point at correctness debt that masks performance debt:

- PR #7 (`Fix: Recursively index subdirectories`, merge `55a0b9b`) — recursion was broken, so no one had measured scans of realistically-deep trees.
- PR #11 (`Do not log to stdout`, merge `167d2f8`) — stdout-safety work; suggests operational observability was only recently stabilized.

With both fixes landed, performance is now the next lever, and a baseline must exist before any further change can be evaluated.

## 3. Goals

- G1. **Publish a reproducible baseline** for cold-start, index-build, warm-query latency, and peak memory — in `benchmarks/` so regressions can be measured.
- G2. **Cut cold-build wall time by ≥5×** for a 100-file / ~500-chunk KB when using a batch-capable provider (OpenAI / HuggingFace `pipeline`), via batched embeddings and a single save.
- G3. **Cut warm-query fixed overhead** so that an unchanged-KB retrieval spends <10 ms on the scan path for the 100-file case.
- G4. **Per-KB index isolation** so that loading/unloading a KB is independent and memory scales with *queried* KBs, not the sum of all KBs.
- G5. **Optional CI regression gate** that fails a PR if bench metrics regress by a configurable threshold.

## 4. Non-goals

- Replacing FAISS with another vector store (out of scope here; see RFC 006 if it proposes one).
- Algorithmic changes to retrieval ranking / hybrid search (RFC 006).
- Lint / coverage / test-quality sweeps (RFC 005).
- Writing the actual refactor — that is a follow-up implementation PR scoped by §10 below.

## 5. Current state (measured)

All numbers below come from a scratch harness in `/tmp/rfc007-bench/` (not checked in), which mocks `FaissStore` and `HuggingFaceInferenceEmbeddings` by patching the prototype of the resolved module and then drives the real built `KnowledgeBaseServer` / `FaissIndexManager` against a synthetic KB. Raw numbers are recorded here so a future benchmark harness can be calibrated against them; the harness itself is specified in §6.

### 5.1 Build & cold-start

| Step                                                   | Wall time | Peak RSS |
| ------------------------------------------------------ | --------: | -------: |
| `npm run build` (TypeScript compile + chmod)           |    2.70 s |   468 MB |
| Module import + `new KnowledgeBaseServer()` (stub env) |    170 ms |    81 MB |
| `FaissIndexManager.initialize()` when no index exists  |      2 ms |       —  |

Notes:
- `build` measurement via `/usr/bin/time -v`. Peak RSS reflects `tsc`, not runtime.
- Constructor time is dominated by `@langchain/*` module loading. No lazy import today.

### 5.2 Cold indexing — 100 markdown files (~3 KB each, ~500 chunks total)

With `embedDocuments` stubbed to **20 ms per chunk** (a realistic lower bound for a local Ollama call; remote HF/OpenAI is frequently 50–200 ms):

| Metric                                    |    Value |
| ----------------------------------------- | -------: |
| `updateIndex()` cold build                | 10 761 ms |
| `FaissStore.save` calls during cold build |      100 |
| `addDocuments` / `fromTexts` calls        |      100 |
| Total chunks embedded                     |      500 |
| RSS delta (after cold build)              |   ~31 MB |

**Interpretation.** 500 × 20 ms = 10 000 ms is the serial-embedding floor. The remaining ~760 ms is filesystem + 100 full-index saves. Switching to a single batched `embedDocuments([...500 chunks])` collapses the first term to ~1 RTT for batch-capable providers; consolidating to one `save()` collapses the second term to a single write.

### 5.3 Warm no-op — every retrieval pays this

Running `updateIndex()` a second time with all hashes matching:

| KB size (files × tiny body) | Warm median (3 runs) | Per-file |
| --------------------------- | -------------------: | -------: |
| 100                         |              84.2 ms |   842 µs |
| 500                         |              83.7 ms |   167 µs |
| 2 000                       |              87.1 ms |    44 µs |

**Interpretation.** At small scale the cost is a ~85 ms fixed floor from async-loop overhead through `getFilesRecursively` + per-file `calculateSHA256` + hash-file read; the per-file cost *shrinks* because the fixed floor dominates. At realistic file sizes (hundreds of KB each) the sha256 cost becomes the dominant term — but the measurement for that case is blocked in this sandbox (see §5.5) and must be collected by the implementation PR with real KBs.

### 5.4 Per-query vs per-scan

- `similaritySearch` with stubbed FAISS: 0.26 ms (FAISS itself is not the bottleneck for small k; the network round-trip to the embedding provider for the query vector is the real cost and is **not measured here** because providers are stubbed).

### 5.5 Measurements blocked in sandbox

- **Real embedding-provider latency** (Ollama / HF / OpenAI): the sandbox has no credentials and no guaranteed-running Ollama daemon. Values must be captured by the implementation PR on the maintainer's box.
- **Real FAISS index load time** from disk for a large index: no persisted index fixture exists in the repo. Fixture creation is deferred to the benchmark harness (§6).
- **Per-request latency under concurrency**: MCP stdio is single-client by design; concurrency benchmarking requires an in-process MCP harness, which the benchmark spec (§6) describes but does not build in round 1.

## 6. Proposed design

The work splits into **one new checked-in artifact** (the benchmark harness) and **four refactors** that the harness is designed to measure the effect of. Each refactor is small enough for a single PR.

### 6.1 Benchmark harness — new artifact

New directory: `benchmarks/`.

**Files:**

- `benchmarks/run.ts` — entry point. Runs one or more scenarios and writes a JSON report. No test framework; a plain `npm run bench` script in `package.json`.
- `benchmarks/scenarios/cold-start.ts` — times module import + `new KnowledgeBaseServer()` + `initialize()` with a pre-persisted index fixture.
- `benchmarks/scenarios/cold-index.ts` — builds an index from scratch over a generated KB of configurable `{files, avg_chunks_per_file}`.
- `benchmarks/scenarios/warm-query.ts` — sha-stable KB; times `updateIndex()` + `similaritySearch()` over 30 repetitions, reports p50/p95/p99.
- `benchmarks/scenarios/memory.ts` — reports `process.memoryUsage()` after cold build; optional `/usr/bin/time -v` wrapper for peak RSS.
- `benchmarks/fixtures/` — a deterministic `kb/` generator + a small persisted FAISS index (<1 MB) checked in for cold-load timing.
- `benchmarks/README.md` — how to run, how to interpret output, how to calibrate against the RFC 007 §5 baseline.

**Provider abstraction for benchmarks.**

The harness accepts `BENCH_PROVIDER=stub|ollama|openai|huggingface`. `stub` uses the same prototype-patching trick as §5 to isolate filesystem/scan cost; the others run end-to-end with a real provider so maintainers can measure what their users will actually experience. Stub mode is CI-default; real mode is a local/manual run.

**Output format (JSON, stable keys).**

```jsonc
{
  "version": 1,
  "git_sha": "<commit>",
  "node_version": "v20.x.y",
  "provider": "stub|ollama|openai|huggingface",
  "scenarios": {
    "cold_start":     { "ms": 170.4, "rss_bytes": 81195008 },
    "cold_index":     { "files": 100, "chunks": 500, "ms": 10761, "save_calls": 100 },
    "warm_query":     { "p50_ms": 85, "p95_ms": 92, "p99_ms": 104 },
    "memory_peak":    { "rss_bytes": 112459776 }
  }
}
```

Keys are intentionally flat under `scenarios` so `jq '.scenarios.warm_query.p50_ms'` works in CI.

**Determinism.** Fixtures must be generated with a seeded PRNG (`mulberry32`, seeded from a constant). No wall-clock dependence in generated content.

### 6.2 Refactor A — Batched embeddings inside `updateIndex`

**Location:** `src/FaissIndexManager.ts:190-281`.

**Change.** Collect all changed-file chunks in memory first, then make batched `addDocuments` (or `fromTexts`) calls with the combined batches. Provider clients (`OpenAIEmbeddings`, `OllamaEmbeddings`, `HuggingFaceInferenceEmbeddings`) all accept `string[]` in `embedDocuments`; batching lets the provider's own client parallelize or, for OpenAI, send one HTTP call with up to 2 048 inputs.

**Bound the batch.** Add `INDEXING_BATCH_SIZE` to `src/config.ts` as an env-overridable number AND a provider-keyed default map:

```ts
// src/config.ts
export const INDEXING_BATCH_SIZE_DEFAULTS: Record<string, number> = {
  openai: 128,
  ollama: 64,
  huggingface: 32,
};
export function getIndexingBatchSize(provider: string): number {
  const envVal = process.env.INDEXING_BATCH_SIZE;
  if (envVal && !Number.isNaN(Number(envVal))) return Math.max(1, Number(envVal));
  return INDEXING_BATCH_SIZE_DEFAULTS[provider] ?? 32;
}
```

**Helper.** `chunked<T>(arr: T[], size: number): T[][]` — a new utility in `src/utils.ts`. Non-generator (simpler call sites; chunk sizes are small so memory is fine). Signature:

```ts
export function chunked<T>(arr: T[], size: number): T[][];
```

**Sketch.**

```ts
// Inside updateIndex, after the changed-file scan:
const pending: {
  chunks: Document[];
  hashWriteTargets: { path: string; hash: string }[];
} = { chunks: [], hashWriteTargets: [] };
// ... populate pending for each changed file ...

const batchSize = getIndexingBatchSize(this.embeddingProvider);
for (const batch of chunked(pending.chunks, batchSize)) {
  if (this.faissIndex === null) {
    this.faissIndex = await FaissStore.fromTexts(
      batch.map(d => d.pageContent),
      batch.map(d => d.metadata),
      this.embeddings,
    );
  } else {
    await this.faissIndex.addDocuments(batch);
  }
}
// --- Crash-safety ordering (see 6.2.1) ---
await this.faissIndex.save(indexFileSavePath);  // 1. persist index FIRST
await Promise.all(pending.hashWriteTargets.map(
  t => fsp.writeFile(t.path + '.tmp', t.hash, 'utf-8')
));
await Promise.all(pending.hashWriteTargets.map(
  t => fsp.rename(t.path + '.tmp', t.path)      // 2. atomic-rename hashes AFTER save
));
```

**Tests.** `FaissIndexManager.test.ts` gains four cases:
1. For 10 changed files producing `C` chunks total, `save` mock is called exactly once and `fromTexts`/`addDocuments` mock is called `Math.ceil(C / batchSize)` times.
2. `save()` rejects → no `pending-manifest.json` on disk, no hash sidecars on disk. Trivially true by construction, but pinned so a future refactor doesn't flip the ordering.
3. **The interesting crash case:** `save()` succeeds, then the fake `fsp.rename` for hash sidecars throws after renaming half of them. Simulated next-startup `initialize()` sees `pending-manifest.json` and the "conservative finish" recovery completes the remaining renames. Re-running `updateIndex()` afterwards yields the same vector count as a clean run.
4. `initialize()` with a leftover `pending-manifest.json` but a missing `faiss.index` → recovery aborts with a clear error rather than producing a partially-hashed state.

#### 6.2.1 Crash-safety invariant

The current code's per-file save+hash-write is *consistent but slow*: every file either has its vectors persisted and its hash written, or neither. The naive batched version from an earlier draft was inconsistent: a crash between `save()` and `fsp.writeFile(hash)` could leave vectors persisted with no hash, and next startup would re-embed and re-add — duplicating vectors in the FAISS store (FAISS does not dedup by source).

The contract the refactor must preserve: **after a crash, no file appears in the index more than once, and no file whose hash is written is missing from the index.**

Strategy:
- **Persist index first** (`faissIndex.save(indexFileSavePath)`). Whether LangChain's `FaissStore.save` issues an `fsync` is not verified in the RFC — the implementation PR must either confirm it does or wrap the call with an explicit `fsync` via `fs.promises.open(path, 'r+').then(fh => fh.sync())`. Flagged in §8.
- **Write hash sidecars via tmp+rename** after index persistence succeeds. On Linux `rename` is atomic within a filesystem; if the process dies mid-batch of renames, some files are "hashed" and some are not — but the "not" set is re-embedded next startup, and because the index file on disk already contains the just-written vectors, **those vectors will be duplicated**.
- **Exactly one `save()` per `updateIndex` call, at the end.** The manifest-based recovery assumes a single save point. A future optimization of "save after each batch" would invalidate the recovery invariant because the manifest only captures the *final* set of pending hashes. The implementation PR must document this constraint in a comment on the save-call line.
- **Concurrency:** this design assumes a single server process per `FAISS_INDEX_PATH`. Running two servers against the same path races on manifest write/unlink; §8 flags this and recommends a process-level lockfile as a follow-up RFC, not part of this one.

To make the invariant hold regardless of where the crash lands, add a **manifest step** that the implementation PR must include:

```ts
// After faissIndex.save(), before any hash-sidecar write:
await fsp.writeFile(
  path.join(FAISS_INDEX_PATH, 'pending-manifest.json.tmp'),
  JSON.stringify({ pendingHashes: pending.hashWriteTargets }),
);
await fsp.rename(/*.tmp*/, path.join(FAISS_INDEX_PATH, 'pending-manifest.json'));
// then write the hash sidecars (tmp+rename each)
// on success:
await fsp.unlink(path.join(FAISS_INDEX_PATH, 'pending-manifest.json'));
```

On startup (`initialize()`), if `pending-manifest.json` exists, the server knows the previous process crashed mid-commit. Options:
- **Conservative** (preferred): finish writing the pending hash sidecars (we know the index file already contains those vectors, so claiming the hashes is correct).
- **Defensive**: detect duplicate vectors by matching `metadata.source` on load, rebuild the index from the first occurrence only, delete the manifest.

The implementation PR must pick one and cover it in the test from (2) above. The RFC does not pre-commit to a choice — both are acceptable.

**Mid-batch crash cost.** With `INDEXING_BATCH_SIZE=128`, at most 128 files × avg chunks/file are "wasted" per crash — the re-embedding cost is bounded by the batch size. Users tuning for reliability can lower the batch; users tuning for throughput can raise it.

### 6.3 Refactor B — Drop the per-query scan (**semver-minor breaking change**)

**Location:** `src/KnowledgeBaseServer.ts:84`.

**Why flagged breaking.** The `README.md:173` promise ("It checks for changes in the knowledge base files and updates the index accordingly") is a user-visible contract. Removing the per-query scan is a real behavior change. This section assumes it ships as a documented minor-version bump; if the maintainer judges it too risky even under a flag, consider the mtime+size short-circuit in §7.5 as a no-breakage substitute.

**Change.** Remove the `await this.faissManager.updateIndex(...)` call from `handleRetrieveKnowledge`. Index refresh becomes:

1. **At startup** (`run()` in `src/KnowledgeBaseServer.ts:124-136`), after `initialize()` completes, schedule a background `updateIndex()` via an un-awaited async call (not `queueMicrotask` — that runs before I/O; use `setImmediate(() => { void this.faissManager.updateIndex(); })`).
2. **File watch** (§6.6): required alongside this refactor when the default flip happens. See §6.6 — on the happy path (macOS / Windows / Linux with `fs.watch({ recursive: true })` support) the watcher is on-by-default; on unsupported platforms it falls back to opt-in with a startup log warning.
3. **Explicit MCP tool** (`refresh_knowledge_base`) — mandatory, ships in the same PR as the flag's introduction. Added via `this.mcp.tool(...)` in `setupTools` (`src/KnowledgeBaseServer.ts:33-50`):

```ts
this.mcp.tool(
  'refresh_knowledge_base',
  'Force a rescan of the given knowledge base (or all KBs if omitted) and update the FAISS index accordingly.',
  {
    knowledge_base_name: z.string().optional().describe(
      'Knowledge base to refresh. If omitted, refreshes all KBs.'
    ),
  },
  async (args) => {
    await this.faissManager.updateIndex(args.knowledge_base_name);
    return { content: [{ type: 'text', text: 'Refreshed.' }] };
  },
);
```

The tool returns synchronously after the refresh completes — callers who want fire-and-forget must implement that client-side.

**Effect.** Warm-query overhead for an unchanged KB goes from ~85 ms + O(N) sha256 to ~0 ms, because no scan happens. The ~85 ms floor measured in §5.3 is entirely scan cost; it disappears.

**Staged rollout.** Note the README update and the mandatory tool both ship in phase 1, not deferred to phase 2:

- **Phase 1** (single PR): add `SKIP_PER_QUERY_INDEX=false` env, add `refresh_knowledge_base` tool, update `README.md:171-184` to document the new contract with the flag-opt-in path highlighted, add `CHANGELOG.md` entry under `[Unreleased] Changed`. At this point the default behavior is unchanged.
- **Phase 2** (one minor version later): flip the default to `SKIP_PER_QUERY_INDEX=true`, ship only when §6.6 watcher has been on-by-default for one release and has <1 reported platform-regression issue, update README to state the new default.
- **Phase 3** (one minor version after that): remove the flag.

If §6.6 watcher cannot be made on-by-default on a given platform, phase 2 does **not** ship for that platform: the default flip is gated on watcher availability.

### 6.4 Refactor C — Per-KB index isolation

**Location:** `src/FaissIndexManager.ts` (whole class) and `src/config.ts:7-8`.

**Change.** Replace the single `this.faissIndex: FaissStore | null` (`src/FaissIndexManager.ts:66`) with a `Map<string, FaissStore>` keyed by knowledge-base name. Each KB gets its own directory under `FAISS_INDEX_PATH`:

```
$FAISS_INDEX_PATH/
  model_name.txt            # global — one model across all KBs
  company/
    faiss.index
    docstore.json
  onboarding/
    faiss.index
    docstore.json
```

**Keep `model_name.txt` global.** The current behavior wipes the index when the embedding model changes (`src/FaissIndexManager.ts:128-139`). That model-change guard must apply atomically across all KBs — splitting it per-KB invites an inconsistent state where some KBs are on model A and others on model B. One `model_name.txt` at the root; when it changes, **all** per-KB index files are deleted and rebuilt.

**New signatures.** Add a named type and a new method, plus amend the existing `similaritySearch`:

```ts
// Named type — define once (src/FaissIndexManager.ts), export for consumers:
export type ScoredDocument = Document & { score: number };

// Public surface:
initialize(): Promise<void>;                                       // unchanged name; now iterates KB subdirs
updateIndex(kbName?: string): Promise<void>;                       // unchanged signature; now routes to one or all
updateIndexForFiles(paths: string[]): Promise<void>;               // NEW — used by the §6.6 watcher
similaritySearch(
  query: string,
  k: number,
  threshold?: number,
  kbName?: string,                                                 // NEW
): Promise<ScoredDocument[]>;
```

**`similaritySearch` threshold interaction.** Threshold (default 2, as today at `src/KnowledgeBaseServer.ts:46`) is passed unchanged into each per-KB `similaritySearchWithScore` call. The fan-out merge does NOT re-apply threshold — it only re-sorts the already-threshold-filtered results. This preserves current semantics: a document below threshold in its own KB's distance space is excluded, regardless of whether it would have been excluded against a global index. Documented so contributors don't "fix" it.

**`updateIndexForFiles` contract (§6.6 watcher):**
- Input: `paths` is a list of absolute file paths, potentially across multiple KBs. KB name is derived from each path (same rule as §6.4.3 migration: first segment after `KNOWLEDGE_BASES_ROOT_DIR`). Paths outside the root are logged and skipped.
- Drain semantics: if a second call arrives while the first is in flight, the second is **queued** in a single-slot pending-call buffer (replacing any earlier queued call). On completion of the in-flight call, the queued paths are merged with any newly-dirty paths from the watcher's dirty-set and processed as one call. This prevents overlapping saves and double-manifest writes.
- Tombstones (deletes): a deleted file's entry in `paths` is detected by `fsp.stat` failure inside `updateIndexForFiles`. Because `faiss-node` does not expose vector deletion, the implementation logs a `warn` ("stale vectors for deleted file; will be cleaned on next full rebuild") and removes the hash sidecar. The orphan vectors remain in the index until the user runs a full rebuild; `CHANGELOG.md` must document this limitation. Follow-up RFC can address FAISS index rebuild-on-delete.

- `handleRetrieveKnowledge` with `knowledge_base_name` set: load only that KB's index (lazily) and search within it.
- Without `knowledge_base_name`: see §6.4.1 ranking-semantics notes and the bounded-LRU memory rule in §6.4.2.
- `list_knowledge_bases` stays the same.

**Per-file hash sidecars stay in-tree.** The existing `.index/<...>/<basename>` layout inside each KB directory (`src/FaissIndexManager.ts:203-204`) is unchanged by this refactor. Sidecars travel with the source files, not with the FAISS index directory; this means a user can `rm -rf $FAISS_INDEX_PATH/` to force a full rebuild without losing the sha tree, and conversely can relocate a KB without invalidating the vectors of another.

**Effect.** Memory scales with the set of *actively queried* KBs (bounded by the LRU cap in §6.4.2).

#### 6.4.1 Ranking semantics for multi-KB queries

**Current behavior.** `handleRetrieveKnowledge` without `knowledge_base_name` runs `faissIndex.similaritySearchWithScore(query, k=10, filter)` against one global index (`src/FaissIndexManager.ts:359`). The top-10 returned is a true global top-10: all scores come from one index, in the same metric space, directly comparable.

**Proposed behavior.** Fan out to each loaded KB, take top-`k'` per KB, merge, re-sort, truncate to `k`.

**This is not equivalent to global top-k.** A result that ranks `k'+1` in KB-A may outrank a result at rank-3 in KB-B and would be returned by the global search but not by the fan-out merge. The recall loss depends on the fan-out factor `f = k' / k`.

**Decision.** Use `k' = f * k` with default `f = 3` (so with `k=10`, each KB returns its top-30 before the merge). Expose `RETRIEVAL_FANOUT_FACTOR` env var (default `3`; clamp to `[1, 10]`).

**Success criterion.** Add a benchmark scenario `benchmarks/scenarios/retrieval-quality.ts` with this specification:

- **Fixture shape (deterministic, seeded):** 5 KBs × 20 files each × ~5 chunks per file = ~500 chunks total. Content generated from a seeded PRNG over a 2 000-token vocabulary so queries have a unique expected match by construction.
- **Query set:** 50 queries, generated by sampling a random 20-token span from a random chunk across all KBs. Seed is fixed (`RETRIEVAL_QUALITY_SEED=42`). Ground-truth label is the source chunk's `(kb, file, chunk-index)`.
- **Procedure:** build one global `FaissStore` from all 500 chunks AND per-KB `FaissStore`s from each group of 100. For each query, run `k=10` against global (baseline) and the fan-out-merge at `k' = k * f` per KB. Compute `recall@10` = `| top10(global) ∩ top10(fanout) | / 10`, averaged over all 50 queries.
- **Fan-out sensitivity sweep (informational, non-blocking):** run the full procedure at `f ∈ {1, 2, 3, 5, 10}` × `loaded_kbs ∈ {3, 5}` and emit all recall numbers into the JSON report. This justifies the `f=3` default if it's chosen; if recall at `f=3` is <0.95 but `f=5` is ≥0.95, raise the default.
- **Blocking gate:** average `recall@10 ≥ 0.95` at the chosen default `f` on the `loaded_kbs = 5` row. If the gate fails at every `f ≤ 10`, the refactor is rejected in its current form; an alternative (e.g. maintain a shadow global index for unscoped queries) is required.

#### 6.4.2 Bounded LRU of loaded indexes

To prevent "query for one KB, then query the global" from reinstating the memory problem, the `Map<string, FaissStore>` becomes an LRU:

```ts
const KB_CACHE_MAX = Number(process.env.KB_CACHE_MAX ?? 8);
// On cache eviction: the FaissStore reference is released; GC handles FAISS memory
// via faiss-node's finalizer. Next query for that KB will reload from disk.
```

Global queries (no `knowledge_base_name`) iterate over the set of existing KB directories but load them **into the LRU in order**; if more KBs exist than the LRU permits, the query emits a `logger.warn` once per query "Loaded K of N KBs — consider increasing KB_CACHE_MAX or scoping queries with knowledge_base_name". This makes the memory ceiling user-controllable and the trade-off observable.

#### 6.4.3 Migration from legacy layout

On startup, `initialize()` detects one of:
- **New layout:** `$FAISS_INDEX_PATH/<kb>/faiss.index` files exist → proceed normally.
- **Legacy layout:** `$FAISS_INDEX_PATH/faiss.index` exists, no per-KB subdirs → run migration.
- **Empty:** nothing exists → nothing to migrate.

**Migration path (blocking on first startup after upgrade):**

1. Read the legacy FAISS index into memory.
2. Derive KB name from each document's `metadata.source` (set at `src/FaissIndexManager.ts:240-247`, value is an absolute path). KB name = first path segment after `KNOWLEDGE_BASES_ROOT_DIR`.
3. **Screen each document before grouping:**
   - (a) If `metadata.source` does not start with `KNOWLEDGE_BASES_ROOT_DIR`: abort the whole migration, log the offending path, advise the user to delete `$FAISS_INDEX_PATH/` manually. This usually means the root dir was relocated between versions.
   - (b) If `metadata.source` starts with root but the file no longer exists on disk (`fsp.stat` fails): drop the document from the migration set and log at `warn` level (path, derived KB). These are orphaned vectors for deleted/moved files.
   - (c) If `metadata.source` exists but is now under a *different* KB than the one derived from the legacy path (file was moved between KBs): drop the document from the migration set and log at `warn` ("moved, will be re-embedded under new KB on next updateIndex"). The screening is authoritative: re-embedding is cheap compared to carrying stale vectors in the wrong index.
4. For each remaining group, create a new per-KB `FaissStore` via `FaissStore.fromDocuments(group, this.embeddings)` and save to `$FAISS_INDEX_PATH/<kb>/`.
5. Validate: count of vectors across all new indexes == (legacy count − dropped count). If not, **abort**, leave legacy in place, log error.
6. On validation success, atomically rename legacy `faiss.index` → `faiss.index.legacy-backup` (do NOT delete — the user will confirm by deleting it themselves after they verify queries still work).
7. Log a `CHANGELOG`-anchored migration notice at `info` level, including the number of dropped documents per screening reason.

Add a `MIGRATE_LEGACY_INDEX=skip` env override for users who prefer to rebuild from source markdown instead (faster if the legacy index is large and the embedding provider is local).

### 6.5 Refactor D — Save-once & parallel hash writes

**Location:** `src/FaissIndexManager.ts:259-273`.

Even if Refactor A is deferred, the save-per-file pattern at line 263 can be hoisted out of the loop without touching the embedding call site:

```ts
// Inside loop, remove:
- await this.faissIndex.save(indexFileSavePath);
- await fsp.writeFile(indexFilePath, fileHash, 'utf-8');

// After the loop, add:
if (indexWasMutated) {
  await this.faissIndex.save(indexFileSavePath);
}
await Promise.all(pendingHashWrites.map(({ p, h }) => fsp.writeFile(p, h, 'utf-8')));
```

This is independent of batching and can ship as the first PR from §10.

### 6.6 File-system watcher (on-by-default where supported; gates §6.3 default-flip)

**New file:** `src/KnowledgeBaseWatcher.ts` (TypeScript, uses `fs.watch` recursively — no new dependency).

- Started in `KnowledgeBaseServer.run()` after `initialize()`.
- Maintains a `Set<string>` of dirty **file paths** (not KB names) — an edit to one file in a 10 000-file KB must not re-hash the other 9 999 files.
- On file-change event: adds the path to the dirty set and schedules a debounced (500 ms) flush that calls a new `updateIndexForFiles(paths: string[])` method — which re-uses the batched/save-once code from §6.2/§6.5 but skips the directory walk.
- Handles editor-quirk events: `rename` + same-name-new-inode (vim/VSCode atomic save), `unlink` (dirty set with tombstone marker for eventual removal from FAISS — FAISS does not natively support delete; the current fallback is "orphaned vectors remain, filtered by later queries if possible" — flag in §8).
- Handles `EMFILE` (too many open file descriptors) by falling back to a single root-level recursive watch rather than per-file watches, plus a startup `logger.warn`.

**On-by-default criteria.** Watcher starts automatically when all of:
- `fs.watch({ recursive: true })` is supported — true on macOS, Windows, and Linux with Node ≥ 20.
- `KNOWLEDGE_BASES_ROOT_DIR` is a local filesystem (detected via `fsp.statfs` where available; if unavailable, default to on anyway with a `debug` log).

**Override.** `WATCH_KNOWLEDGE_BASES=false` force-disables; `WATCH_KNOWLEDGE_BASES=true` force-enables (accepting user risk on unsupported platforms).

**Why this change from opt-in to on-by-default.** Round-1 review flagged that §6.3's default-flip to `SKIP_PER_QUERY_INDEX=true` (stage 6 in §9) leaves users with no auto-refresh at all unless the watcher is running. The watcher is load-bearing for the staged rollout; making it opt-in there would break the README promise with no mitigation. If the watcher cannot be made stable on-by-default, stage 6 does not ship.

### 6.7 Observational clean-ups (small, bundle with refactors above)

- Remove the stale `src/knowledge-base-server-flow.md` mermaid diagram (it describes code that no longer exists; see §2.1). Replace with a short "see `docs/rfcs/007-*` and the current source" note, or refresh the diagram as part of Refactor A's PR.
- Mark `@langchain/openai` as a direct dependency in `package.json` — it is imported at `src/FaissIndexManager.ts:7` but only resolved transitively via `langchain`/`@langchain/community`. Today it happens to work; one upstream minor bump can remove it.
- Replace `fs.existsSync(...)` at `src/FaissIndexManager.ts:112,130,141,206` with `fsp.stat().catch(() => null)`-style checks to avoid blocking the event loop.

These are not the main theme but are cheap riders on the refactor PRs.

## 7. Alternatives considered

### 7.1 "Just add a cache" for file hashes

Keep the per-query scan but cache file-hash reads in memory so the second query is fast. **Rejected.** Mem-cache invalidation reintroduces the same "is my index fresh?" question while masking it; users who change files between queries get stale results with no signal.

### 7.2 Switch persistence format to SQLite-backed vector store

Replace FAISS+JSON persistence with `sqlite-vec` or `duckdb` (persistent, concurrent). **Rejected here — RFC-scope creep.** It may be worth a separate RFC, but within the scope of "measure and remove obvious waste", swapping the storage engine is a much larger surface-area change than batching + save-once.

### 7.3 Worker thread pool for embeddings

Offload embedding calls to `worker_threads`. **Rejected.** The bottleneck is network I/O, not CPU. A worker pool helps if the provider is a local CPU-bound embedding (e.g. running `sentence-transformers` in-process), but this repo delegates all embedding to remote (HF, OpenAI) or a separate service (Ollama). Batching already exploits the same parallelism the pool would.

### 7.4 Delete per-file hash sidecar files

Store hashes in a single `hashes.json` per KB instead of one hash file per source file (`src/FaissIndexManager.ts:203-204`). **Considered but deferred.** Simpler persistence, fewer inodes, but the current design survives partial-write crashes better and readers are O(1) per file. Revisit if file-count warm-path profiling shows inode churn as a hot spot.

### 7.5 mtime+size short-circuit (no-breakage substitute for §6.3)

Instead of (or in addition to) dropping the per-query scan, compare `(mtime, size)` from the sidecar before computing sha256. This is the classic Make/rsync trick:

- On first-pass or hash-mismatch, store `{ hash, mtime, size }` in the sidecar instead of just `hash`.
- On subsequent scans, `fsp.stat(path)` is ~5 µs; if `(mtime, size)` match the stored record, skip sha256 entirely.
- If they differ, fall through to sha256 as today — correctness is preserved for any editor that updates in place.

**Expected impact.** Warm-query scan cost on realistic files is dominated by sha256, not by the async-loop floor. Short-circuiting with `stat` likely cuts warm scans by 10–100× for large files without changing any externally-observable semantics.

**Why this is a real alternative to §6.3.** §6.3 removes the scan entirely; §7.5 makes the scan cheap. §6.3 needs a README change and a watcher; §7.5 needs neither. If wall-time measurements from the §6.1 harness show §7.5 alone hits G3 (<10 ms warm overhead on the 100-file case), then **§6.3 can be rejected** and the staged default-flip (stages 3 & 6 in §9) does not ship — the mtime short-circuit gives us the win without the breakage.

**Recommended sequencing.** Land §7.5 in stage 1 alongside the save-hoist. Re-measure. Decide whether §6.3 is still worth the churn. This is a first-class path, not a fallback — flagged for decision in §8.

## 8. Risks, unknowns, open questions

- **§5 numbers are stubs, not production metrics.** 20 ms/chunk simulates a local Ollama round-trip; real remote OpenAI/HF calls may be 50–200 ms/chunk and add network variance. §10 success metrics are **split** into stub-mode structural targets (call counts, ratios) and real-provider wall-time targets (which need a baseline captured by the maintainer before stage 2 ships).
- **No measurement of real FAISS `load` time.** Depends heavily on index size and disk. Implementation PR must generate a ≥10 MB index fixture and measure.
- **Fixture portability.** `faiss-node` index files embed platform-endian floats + a pickled docstore. A checked-in fixture may not load cross-platform. The §6.1 harness must regenerate fixtures at bench-start if the CI OS/arch differs from the one used to build the checked-in copy — and baseline result files must be keyed by `{node_version}-{os}-{arch}` (e.g. `benchmarks/results/v0.1-node20-linux-x64.json`).
- **Per-KB split (§6.4) changes on-disk layout.** The migration path in §6.4.3 preserves the legacy file as a `.legacy-backup` and validates vector count before promoting. Users on managed environments (Smithery, Docker) need a `CHANGELOG.md` entry and, if a volume is used, a note to keep it mounted through the upgrade so the migration can happen in place.
- **§6.3 vs §7.5 decision.** If §7.5 (mtime+size short-circuit) alone hits G3, §6.3's breaking-change surface is not justified. This decision point is explicit in the §9 rollout table and **must be made by the maintainer after stage 1 benchmarks land**.
- **Global query after §6.4.** With no `knowledge_base_name`, the fan-out-and-merge path (§6.4.1) plus the bounded-LRU cap (§6.4.2) yields recall-degraded results once loaded-KB count exceeds `KB_CACHE_MAX`. The one-per-query `logger.warn` surfaces this; no silent regression. The §6.4.1 recall@10 ≥ 0.95 gate is what protects query quality for users who stay under the cap.
- **Refactor A crash recovery.** §6.2.1 adds a `pending-manifest.json` + tmp+rename pattern; the implementation PR must pick between "conservative finish" and "defensive rebuild" on startup-detection of the manifest. Both are documented, neither is pre-committed.
- **Ollama batching behavior.** `OllamaEmbeddings.embedDocuments` accepts an array, but whether it issues one call or N is implementation-dependent. Implementation PR should inspect the `@langchain/ollama` source and may need a direct HTTP batch path if it silently serializes.
- **Jest mocking strategy for `FaissStore`.** The existing `src/FaissIndexManager.test.ts` uses `jest.mock('@langchain/community/vectorstores/faiss', ...)` — a static ESM mock. Tests for the new batched path should keep this pattern (not adopt the `/tmp/rfc007-bench/` prototype-patch hack, which was a one-off for the sandbox benchmark because `jest.mock` is not available outside Jest). Document the pattern in `benchmarks/README.md` so a contributor doesn't reinvent.
- **Regression gate threshold.** 20 %? 50 %? noisy CI runners mis-flag at 20 %. Recommend **adopt as warn-only** initially, promote to block after two weeks of calibration.
- **`@langchain/openai` is imported but not a direct dependency.** `src/FaissIndexManager.ts:7` imports from `@langchain/openai` but it only appears as a transitive dep in `package-lock.json` — one upstream minor-version bump can remove it. This is a latent build break. The implementation checklist (§11) moves the fix to PR **0.0** — the first PR, before the harness — instead of "housekeeping at end".
- **`setImmediate` vs `queueMicrotask` for background refresh.** The §6.3 sketch specifies `setImmediate` (runs after current I/O completes) because `queueMicrotask` runs before I/O and would block the server from answering MCP handshake messages while the index rebuilds.
- **jest/ts-jest configuration.** `jest.config.js:6` uses `extensionsToTreatAsEsm: ['.ts']` — adding bench code must not perturb the Jest test match (`testMatch: ["**/src/**/*.test.ts"]` → bench in `benchmarks/` won't be picked up; confirmed safe).

### Open items surfaced in review round 2 (for the maintainer to resolve)

- **§6.2.1 `fsync` behavior of `FaissStore.save`.** Not verified. Implementation PR 2.1 must either confirm LangChain's `save` issues an fsync, or wrap the call explicitly. If neither is done, crash-safety claims for power-loss events are weakened to "process-crash-safe only".
- **§6.2.1 concurrent servers.** Two server processes against the same `$FAISS_INDEX_PATH` race on manifest write/unlink; the recovery logic can corrupt. A process-level lockfile (`O_EXCL` on `$FAISS_INDEX_PATH/.lock`) is the natural fix but belongs in a follow-up RFC; for now, the README should state "one server process per FAISS_INDEX_PATH."
- **§6.4.2 faiss-node finalizer.** The LRU memory-ceiling argument assumes dropping a JS reference to `FaissStore` promptly frees native memory. Whether `faiss-node`'s binding uses a Napi destructor or relies on V8 GC is not verified here. Implementation PR 4.1 must (a) inspect `faiss-node`'s source and confirm, OR (b) expose an explicit `close()` / `dispose()` call and invoke it on LRU eviction. If neither, the LRU cap becomes a *heuristic* rather than a hard memory ceiling — flag in CHANGELOG.
- **§9 decision gate A specifics.** "Does §7.5 hit G3?" is measured on a realistic fixture (500 files × 100 KB each, per §10.2). The 100-file / ~3 KB fixture from §5 is too small to distinguish §7.5 from §6.3. Implementation PR 1.2 must use the realistic fixture; if not available yet, gate A cannot be decided and stage 3.1 must wait.
- **§9 decision gate B specifics.** "Has the watcher been stable for one release with <1 platform regression?" — "release" here means "one `main`-tagged version". If the repo does not cut versioned releases regularly (the current version is `0.1.0` per `package.json`), the maintainer may substitute a calendar interval (recommended: 21 days on `main` with no reverts of the §6.6 watcher PR).
- **§6.4 "dispose on eviction" is not specified in §11.** If §6.4.2 adopts an explicit `dispose()` (per the above faiss-node item), the implementation checklist PR 4.1 must include a test that dispose is called on eviction. Added as a conditional sub-item below.

## 9. Rollout plan

Staged, one PR per stage, each ≤500 lines diff:

| Stage | PR                                                                   | Risk  | Depends on | Gate                                                                       |
| ----- | -------------------------------------------------------------------- | ----- | ---------- | -------------------------------------------------------------------------- |
| **0.0** | Declare `@langchain/openai` as a direct dep (§6.7)                 | low   | —          | `npm ci` on a clean cache succeeds.                                        |
| 0.1   | Benchmark harness (§6.1) — stub mode only                            | low   | 0.0        | Lands as a no-op CI job that writes a JSON artifact.                       |
| 0.2   | Maintainer captures real-provider baselines (OpenAI/Ollama) and checks in `benchmarks/results/baseline-{provider}-node20-linux-x64.json` | low | 0.1 | Real-provider numbers exist before any refactor lands. |
| 1.1   | Save-once & parallel hash writes (§6.5, §6.7)                        | low   | 0.1        | Stub cold-build shows ≥40 % drop; `save` call count falls from N to 1.    |
| 1.2   | **mtime+size short-circuit (§7.5)**                                  | low   | 1.1        | Warm no-op overhead drops ≥80 % on realistic file sizes.                   |
| **Decision gate A** — *Does §7.5 alone hit G3?* If yes, skip stages 3 and 6; §6.3 is rejected. | — | 1.2 | Maintainer call. |
| 2.1   | Batched embeddings (§6.2) + crash-safety manifest (§6.2.1)           | med   | 1.1        | Stub structural: `embedDocuments` call count == ceil(chunks/batch). Real-provider wall-time ≥5× improvement vs stage 0.2 baseline. |
| 3.1   | §6.3 phase 1 — add `SKIP_PER_QUERY_INDEX=false` (opt-in), `refresh_knowledge_base` tool, README update, CHANGELOG entry | med | 2.1, and decision gate A = "§6.3 still needed" | Warm-query p50 <10 ms with flag set. |
| 4.1   | Per-KB index isolation + §6.4.3 legacy migration + §6.4.1 recall benchmark | high | 2.1 | **recall@10 ≥ 0.95** vs single-global-index baseline on fan-out factor `f=3`. |
| 4.2   | `handleRetrieveKnowledge` fan-out wiring + §6.4.2 bounded LRU        | high  | 4.1 (same PR preferred) | Regression gate from 4.1 passes; global-query warning emitted when cache thrashes. |
| 5.1   | File watcher (§6.6) — on-by-default where supported                  | med   | 2.1        | Dirty-file re-index latency <500 ms p95; no regression on unsupported platforms. |
| **Decision gate B** — *Has §6.6 watcher been stable on-by-default for one release with <1 platform regression?* | — | 5.1 | Maintainer call. |
| 6.1   | §6.3 phase 2 — flip default of `SKIP_PER_QUERY_INDEX` to `true`, update README | med | 3.1, 5.1, and decision gate B = yes | CHANGELOG.md entry; no scan-on-query unless flag set false. |
| 7.1   | (Optional) §6.3 phase 3 — remove `SKIP_PER_QUERY_INDEX` flag entirely | low | 6.1, one release later | No users relying on opt-out. |
| 7.2   | (Optional) Promote benchmark CI job from warn-only to failing-at-threshold | low | 0.1 green for ≥2 weeks | CI lane stable. |

**Dependency notes:**
- Stage 2.1 **must** land before 3.1: the background `updateIndex()` that replaces the per-query scan would otherwise issue N serial embedding calls and N saves on startup, negating 3.1's own warm-query gate.
- Stages 4.1 and 4.2 are logically two changes but **must ship in a single PR**: 4.1 without 4.2 means the "no `knowledge_base_name`" code path silently returns only one KB's results.
- Stage 6.1 is explicitly gated on **both** 3.1 AND 5.1 (the watcher). If 5.1 cannot be made on-by-default on all supported platforms, 6.1 does not ship — full stop.

Backward compatibility: Stages 0.0–2.1, 1.2, 4.1–4.2, 5.1 are pure wins (no behavior change or additive-only change). Stages 3.1/6.1/7.1 form the staged breaking-change for §6.3, only if decision gate A chooses it.

## 10. Success metrics

Targets are split into (a) **structural** targets measured in stub mode — these prove the refactor changed the call pattern, and (b) **wall-time** targets measured against a real provider — these prove users see a speed-up. Stub targets are not wall-time claims; they are ratios and call-counts that should hold on any machine.

### 10.1 Structural targets (stub mode, `BENCH_PROVIDER=stub`)

These gate PRs at CI time:

| Metric                          | Baseline (§5)      | Target                                | Stage |
| ------------------------------- | -----------------: | ------------------------------------: | :---: |
| `FaissStore.save` call count during cold build of 100 files | 100              | 1                                     | 1.1   |
| `embedDocuments` call count during cold build of 100 files / ~500 chunks | 100 (per-file) | ceil(500 / batchSize) = 4–16          | 2.1   |
| Warm no-op wall time **ratio** vs stage-0 stub-mode baseline on the same runner | 1.0 | ≤0.15 (i.e. ≥85 % reduction) | 1.2 or 3.1 |
| recall@10 (fan-out merge vs global baseline, 50 queries)    | 1.0 (baseline)    | ≥0.95                                 | 4.1   |
| Peak RSS growth per loaded KB vs total KBs                  | grows with total  | linear in loaded-in-LRU only          | 4.2   |

### 10.2 Wall-time targets (real providers)

Gate is applied against the stage-0.2 baseline file `benchmarks/results/baseline-{provider}-{nodev}-{os}-{arch}.json`.

| Metric              | Provider  | Target                                    | Stage |
| ------------------- | --------- | ----------------------------------------: | :---: |
| Cold index build    | OpenAI    | ≥5× faster vs stage-0.2 baseline          | 2.1   |
| Cold index build    | Ollama    | Target set in stage 2.1 PR after investigating whether `@langchain/ollama` actually batches (see §8). If it serializes, target is "≥1.2× faster + tracking issue opened upstream"; if it batches, target is "≥3× faster". | 2.1 |
| Query p95 end-to-end | OpenAI   | <500 ms                                   | any (observational) |
| Warm no-op          | any       | <10 ms on a 500-file / 100 KB-per-file realistic KB       | 1.2 or 3.1 |

**Why "≥5×" is now a meaningful claim.** It is computed against a real maintainer-captured baseline that exists before the refactor lands — not against the §5 sandbox stub.

### 10.3 Non-numeric success signals (not merge gates — post-release observations)

These do **not** block any PR. They are post-release observations that inform whether stage 6.1 (default-flip) should be kept, reverted, or followed up with tooling:

- `CHANGELOG.md` and `README.md:171-184` updates land in the same PR as the behavior change they describe. *(This one IS a merge gate — kept here for visibility; also enforced in the §11 checklist.)*
- **Post-release signal:** no GitHub issue in the 30 days after §6.3 phase 2 (stage 6.1) lands reporting a "my edits aren't being picked up" surprise on a platform where the watcher was advertised as on-by-default. If ≥1 such issue arrives, stage 6.1 must be reverted (flag back to default `false`) pending a watcher fix.
- The `benchmarks/results/` directory grows monotonically — every PR touching indexing appends a fresh result file. *(Merge gate; checked by CI lint.)*

## 11. Implementation checklist

Each numbered item maps to a single PR unless the note says otherwise. Stages and dependencies mirror §9.

### PR 0.0 — Declare missing direct dep (blocks everything)

- [ ] **0.0.1** Add `"@langchain/openai": "^0.x"` to `package.json` `dependencies` — it is imported at `src/FaissIndexManager.ts:7` but only resolved transitively. Verify `npm ci` on a clean cache succeeds. Pin to the range already present in the lockfile.

### PR 0.1 — Benchmark harness (no behavior change)

- [ ] **0.1.1** Add `benchmarks/` directory with `run.ts`, `scenarios/{cold-start,cold-index,warm-query,memory,retrieval-quality}.ts`, and a seeded-PRNG fixture generator (§6.1).
- [ ] **0.1.2** Add `benchmarks/README.md` describing JSON schema, how to run in stub vs real mode, and the Jest-based mocking strategy for `FaissStore`/embeddings (§8).
- [ ] **0.1.3** Add `npm run bench` script to `package.json`.
- [ ] **0.1.4** Add CI job running `npm run bench` with `BENCH_PROVIDER=stub`, uploading JSON as an artifact; **does not** fail the build.
- [ ] **0.1.5** Commit an initial `benchmarks/results/baseline-stub-nodeXX-{os}-{arch}.json` so later PRs can diff against it.

### PR 0.2 — Real-provider baseline (maintainer-local, one-time)

- [ ] **0.2.1** Maintainer runs `BENCH_PROVIDER=ollama npm run bench` and `BENCH_PROVIDER=openai npm run bench` on their workstation; commits `benchmarks/results/baseline-{provider}-nodeXX-{os}-{arch}.json`. No code changes required.

### PR 1.1 — Save-once + non-blocking `existsSync` removal

- [ ] **1.1.1** Hoist `FaissStore.save()` out of the per-file loop in `FaissIndexManager.updateIndex` so it runs once after all changed files are added (§6.5).
- [ ] **1.1.2** Order hash-sidecar writes **after** the successful `save()` and use tmp+rename for atomicity (§6.2.1 initial version; the full manifest lands in 2.1).
- [ ] **1.1.3** Replace `fs.existsSync` calls at `src/FaissIndexManager.ts:112,130,141,206` with non-blocking `fsp.stat(...).catch(...)` (§6.7).
- [ ] **1.1.4** Extend `src/FaissIndexManager.test.ts` with a case asserting `save` is called exactly once per `updateIndex` invocation with ≥2 changed files.
- [ ] **1.1.5** Run `npm run bench`; commit `benchmarks/results/stage-1.1-stub-*.json` showing `save` call count drop (§10.1).

### PR 1.2 — mtime+size short-circuit (§7.5)

- [ ] **1.2.1** Change hash-sidecar format from `hash` to `{ hash, mtime, size }` (JSON, backward-compat parse: if content isn't JSON, treat as legacy hash-only string).
- [ ] **1.2.2** In `updateIndex`, `fsp.stat(filePath)` before `calculateSHA256`; if `{mtime, size}` match the sidecar record, skip sha256.
- [ ] **1.2.3** Test for: (a) stat-match skips sha (fast path), (b) mtime-mismatch falls through to sha and re-indexes correctly, (c) legacy-format sidecar is upgraded in place on first match.
- [ ] **1.2.4** Commit `benchmarks/results/stage-1.2-*.json`. **Decision gate A** happens here: maintainer decides whether §6.3 is still needed.

### PR 2.1 — Batched embeddings + crash-safety manifest

- [ ] **2.1.1** Add `chunked<T>(arr: T[], size: number): T[][]` to `src/utils.ts`.
- [ ] **2.1.2** Add `INDEXING_BATCH_SIZE_DEFAULTS` map and `getIndexingBatchSize(provider)` helper to `src/config.ts` (§6.2).
- [ ] **2.1.3** Refactor `FaissIndexManager.updateIndex` to build a `pending.chunks[]` list for all changed files, then call `FaissStore.fromTexts` / `addDocuments` in batches of `getIndexingBatchSize(provider)` (§6.2).
- [ ] **2.1.4** Implement the `pending-manifest.json` crash-safety protocol in §6.2.1. Handle detection on `initialize()` with the **conservative finish** strategy (simpler; defensive rebuild can come later if needed).
- [ ] **2.1.5** Add `FaissIndexManager.test.ts` cases: (a) batch-size call-count semantics, (b) simulated `save()` rejection leaves no hash sidecars, (c) duplicate-vector invariant holds after simulated mid-commit crash.
- [ ] **2.1.6** Commit `benchmarks/results/stage-2.1-{stub,real}-*.json` showing ≥5× real-provider cold-build improvement vs 0.2 baseline (§10.2).

### PR 3.1 — (Conditional on decision gate A) Opt-in `SKIP_PER_QUERY_INDEX`

- [ ] **3.1.1** Add `SKIP_PER_QUERY_INDEX` env var (default `false`) to `src/config.ts` and wire into `handleRetrieveKnowledge` at `src/KnowledgeBaseServer.ts:84`.
- [ ] **3.1.2** In `KnowledgeBaseServer.run` (`src/KnowledgeBaseServer.ts:124-136`), after `initialize()` completes, call `setImmediate(() => { void this.faissManager.updateIndex(); })` to schedule a background refresh without blocking the MCP handshake.
- [ ] **3.1.3** Add the `refresh_knowledge_base` MCP tool (with Zod schema per §6.3) to `setupTools` at `src/KnowledgeBaseServer.ts:33-50`. **Mandatory** — ships in the same PR.
- [ ] **3.1.4** Update `README.md:171-184` to document both the current default and the opt-in flag; update `CHANGELOG.md` under `[Unreleased] Changed`.
- [ ] **3.1.5** Warm-query benchmark with flag set must show p50 <10 ms (§10.1).

### PR 4.1 + 4.2 — Per-KB index isolation (single PR, not two)

- [ ] **4.1.1** Add `RETRIEVAL_FANOUT_FACTOR` env + `KB_CACHE_MAX` env to `src/config.ts` (§6.4).
- [ ] **4.1.2** Replace `this.faissIndex: FaissStore | null` (`src/FaissIndexManager.ts:66`) with a bounded-LRU `Map<string, FaissStore>` (§6.4.2). Keep `model_name.txt` at the root of `$FAISS_INDEX_PATH`.
- [ ] **4.1.3** Refactor `updateIndex(kbName?)` to route to per-KB indexes; `similaritySearch(query, k, threshold, kbName?)` gains the `kbName` parameter.
- [ ] **4.1.4** `handleRetrieveKnowledge` fan-out: with `knowledge_base_name`, load-and-search one; without, fan out `k' = k * RETRIEVAL_FANOUT_FACTOR` per loaded KB, merge, re-sort, truncate (§6.4.1). Emit once-per-query `logger.warn` when LRU thrashes.
- [ ] **4.1.5** Implement §6.4.3 legacy-layout migration: detect, group by `metadata.source`, rebuild per-KB, validate counts, rename old file to `.legacy-backup`, leave user to delete.
- [ ] **4.1.6** Add `benchmarks/scenarios/retrieval-quality.ts` and the recall@10 ≥0.95 gate (§10.1). **Block merge if the gate fails**.
- [ ] **4.1.7** Add test: migration from legacy layout on a fixture index produces per-KB indexes with matching vector counts, including cases for the three §6.4.3 screening outcomes (outside-root abort, orphaned-file drop, moved-between-KB drop).
- [ ] **4.1.8** (Conditional — see §8 faiss-node finalizer open item) If the maintainer elects to add explicit `dispose()` instead of relying on GC, add a unit test that asserts `dispose` is called when an entry is evicted from the LRU.
- [ ] **4.1.9** Document per-KB layout + migration in `CHANGELOG.md` and `README.md` "Additional Configuration" (`README.md:80-84`).

### PR 5.1 — Watcher on-by-default where supported

- [ ] **5.1.1** Create `src/KnowledgeBaseWatcher.ts` using `fs.watch({ recursive: true })` with `Set<string>` dirty-file tracking (§6.6).
- [ ] **5.1.2** Wire `updateIndexForFiles(paths: string[])` into `FaissIndexManager` reusing the §6.2 batched path.
- [ ] **5.1.3** On-by-default criteria + `WATCH_KNOWLEDGE_BASES` override (§6.6). Startup log indicates whether watcher is active and why.
- [ ] **5.1.4** Handle `EMFILE` fallback, editor atomic-rename, and tombstoning for deletes (§6.6 + §8).
- [ ] **5.1.5** Add env documentation to `README.md` "Additional Configuration" (`README.md:80-84`).

### PR 6.1 — (Conditional on decision gates A and B) Flip `SKIP_PER_QUERY_INDEX` default

- [ ] **6.1.1** Flip `SKIP_PER_QUERY_INDEX` default to `true` in `src/config.ts`.
- [ ] **6.1.2** Update `README.md:171-184` to describe the new default and the watcher's role.
- [ ] **6.1.3** Deprecate the env flag (documented removal in a later minor). CHANGELOG entry under `[Unreleased] Changed`.

### PR 7.1 — (Optional) Remove deprecated flag

- [ ] **7.1.1** Delete `SKIP_PER_QUERY_INDEX` handling; README update to remove references.

### PR 7.2 — (Optional) Promote CI benchmark job to blocking

- [ ] **7.2.1** Switch the CI job from warn-only to block-at-threshold (recommend 25 % regression threshold on wall-time metrics, with a manual-override label escape hatch).

### Housekeeping (bundle opportunistically with any PR above)

- [ ] **H.1** Refresh or delete `src/knowledge-base-server-flow.md` — it references `GCP Credentials`, `OpenAI Embeddings`, and `Stubbed Similarity Search`, none of which match the current code (§6.7, §2.1).

---

*End of RFC 007.*
