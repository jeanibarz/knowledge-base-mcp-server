# RFC 017 — Contextual Retrieval at Ingest

**Status:** Draft (v3 — post-round-2 critic revision)
**Depends on:** RFC 013 (per-model layout), RFC 014 (atomic save), RFC 015 (warm-LLM endpoint discovery), RFC 016 (docstore dedup, `withSidecarLock`)
**Tracks:** retrieval quality on chunked notes that lose pronoun / heading / section context

## Problem

Each KB note is split by `MarkdownTextSplitter` into ~1000-char chunks (`src/file-ingest.ts:200-216`). The embedding model sees each chunk in isolation. A chunk that says

> "We pin it to CPU because the 24 GB card is already maxed by the gate model."

does not know *which* daemon is being pinned, *which* card, *which* gate model — the surrounding paragraphs do. The dense vector accordingly clusters with other "pinning" passages rather than with "GPU contention with Qwen3.6 on a 24 GB RTX 3090" — the actual semantic neighborhood. The result is silent recall failure on the kinds of queries the operator actually issues ("how do I stop the llama-server / Ollama / n8n stack on this box").

Anthropic's *Introducing Contextual Retrieval* (Sept 2024) measured a **49% reduction in top-5 retrieval failures** on a code-and-prose benchmark when each chunk was prepended with a 50-100-token LLM-generated context describing *where in the document the chunk sits*, before embedding. The fix is structural (operates at ingest, not retrieval) and composable with the hybrid BM25+dense+RRF path the codebase already runs (#206).

The KB-MCP server has all the ingredients to implement this:
- A warm local LLM (RFC 015 — `llama-server` Qwen3.6-35B-A3B at `127.0.0.1:8080`, OpenAI-compatible).
- An LLM client (`src/llm-client.ts`).
- A versioned per-model index layout that survives reindex (RFC 014).
- A chunker that walks the markdown tree (`buildChunkDocuments` in `src/file-ingest.ts`).

What's missing is (a) the wiring that calls the LLM per chunk at ingest, (b) a cache so a reindex doesn't re-burn GPU on unchanged chunks, and (c) a one-shot reindex command that backfills every existing shelf.

## Goal

Make embeddings stored in FAISS reflect each chunk's position in its source document, while keeping the chunk text returned to callers (MCP `retrieve_knowledge`, `kb search`) byte-identical to today.

Concretely:

- At ingest, generate a 50-150 token "where in this document does this chunk sit" preface per chunk via the warm local LLM.
- Embed `{preface}\n\n{original_chunk}` — the preface is part of the embedding input.
- Store the **original chunk** in the docstore unchanged. Callers continue to see the source passage verbatim.
- Cache prefaces in a content-addressed sidecar so re-running ingest on unchanged files is a free cache hit, not a re-burn of the LLM.
- Ship a `kb reindex --with-context` command that backfills every shelf during the 11:00-23:00 UTC quiet window (the local-research-agent ingest cron owns 06:00-10:30 UTC).
- Feature-gate the whole thing behind `KB_CONTEXTUAL_RETRIEVAL=on|off` (off by default). Indexes built without contextual prefaces continue to work; the embedding space is mixed during a partial rollout but each chunk remains queryable.

**Non-goals:**

- Reranking. Anthropic combines contextual embeddings with a cross-encoder reranker for their best numbers; that's a separate RFC.
- Late chunking (Jina, 2024). Different ingest architecture.
- Query-time LLM rewriting. Out of scope.
- Multi-document context. The preface is generated from a single source file only.
- Replacing dense retrieval. Hybrid BM25+dense+RRF stays the default; this RFC changes what gets embedded, not how retrieval ranks.

## Design

### 1. Ingest pipeline injection point

`src/file-ingest.ts` `buildChunkDocuments` currently:

```ts
const documents = await splitter.createDocuments([body], [{ source: filePath }]);
for (let i = 0; i < documents.length; i += 1) {
  documents[i].metadata = { …, chunkIndex: i, … };
}
```

After RFC 017 (only when `KB_CONTEXTUAL_RETRIEVAL=on`):

```ts
const originalStat = await fs.stat(filePath);
const documents = await splitter.createDocuments([body], [{ source: filePath }]);

// documentHash is computed from the SAME buffer the splitter saw (not re-read
// from disk) so a concurrent edit cannot create a stale hash / fresh chunks pair.
const documentHash = sha256(body);

const prefaces = await resolveContextualPrefaces({
  source: filePath,
  documentHash,
  documentBody: body,
  chunks: documents.map(d => d.pageContent),
});

// Eventually-consistent check: if the file mutated between loadFile() and the
// end of the LLM phase, discard prefaces and bail. Note: this only narrows the
// window — a mutation AFTER this stat but BEFORE addVectors completes can still
// land in the index. The next ingest cycle reconciles via documentHash diff.
// The invariant we provide is "eventually consistent," not "no stale vector
// ever visible."
const recheckStat = await fs.stat(filePath);
if (recheckStat.mtimeMs !== originalStat.mtimeMs || recheckStat.size !== originalStat.size) {
  throw new RetryableError('file mutated during contextual-preface resolution');
}

for (let i = 0; i < documents.length; i += 1) {
  const preface = prefaces[i];                                        // null on failure
  documents[i].metadata = {
    …,
    chunkIndex: i,
    ...(preface ? { contextual_preface: preface } : {}),              // single field only
  };
}
return documents;
```

`buildChunkDocuments` continues to return chunks whose `pageContent` is the **original** text; metadata carries the preface for the embedder to consume. The `generator` and `model` identifiers do **not** live on every chunk — they live in the sidecar header only.

### 2. `resolveContextualPrefaces` — cache + LLM call

New module `src/contextual-preface.ts`. Exports:

```ts
// Returns one preface per chunk (null = generation failed, embed verbatim).
// Logging is emitted internally via the canonical log; the function does not
// surface a stats object — callers don't need it.
export async function resolveContextualPrefaces(args: {
  source: string;
  documentHash: string;
  documentBody: string;
  chunks: string[];
}): Promise<(string | null)[]>;

// Used by both the dense embedder (FaissStoreAdapter) and the BM25 lexical
// index. Single source of truth so the two retrieval lanes index the same
// prepended text.
export function embeddingText(doc: Document): string {
  const preface = doc.metadata?.contextual_preface;
  if (typeof preface !== 'string' || preface.length === 0) return doc.pageContent;
  return `${preface}\n\n${doc.pageContent}`;
}
```

**Flow:**

1. Read `<faiss_index_path>/.contextual-prefaces/<kb-name>/<relative-path>.json` if present. **All reads and writes of this directory are wrapped in `withSidecarLock` from `src/write-lock.ts:135`** — the same primitive RFC 016 uses for docstore CAS. The per-model `withWriteLock` does not protect cross-model sidecar collisions on shared paths.
2. For each chunk:
   - Compute `chunkHash = sha256(chunk)`.
   - If sidecar has a record at index `i` with matching `chunkHash`, `chunkIndex == i`, **non-null `preface`**, matching `generator`, matching `model`, matching `documentHash`, matching `chunk_size` + `chunk_overlap` env values → cache hit; reuse.
   - Else → call the LLM (§4). On success, slot into the result. **On failure** (`preface: null`), do **not** mark this as a permanent cache hit; future runs treat it as retryable subject to a per-error retry-after deadline (§Failure modes).
3. Per-file sidecar writes happen **per-KB at swap time** (§5 step 7), not per-file inline. The in-memory cost per run is bounded by the largest KB, not the whole corpus.

Sidecar shape:

```json
{
  "schema_version": "contextual-preface.v1",
  "source": "/home/jean/knowledge_bases/operating-environment/local-research-agent.md",
  "knowledge_base": "operating-environment",
  "document_hash": "<sha256>",
  "generator": "contextual-preface.v1",
  "model": "qwen3.6-35b-a3b",
  "chunk_size": 1000,
  "chunk_overlap": 200,
  "chunks": [
    { "chunk_index": 0, "chunk_hash": "<sha256>", "preface": "…", "generated_at": "2026-05-14T22:00:00Z" },
    { "chunk_index": 1, "chunk_hash": "<sha256>", "preface": null,
      "error_code": "llm_unreachable", "next_retry_after": "2026-05-15T22:00:00Z" }
  ]
}
```

Key invariants:
- `document_hash` is the fast-skip gate: identical document body + identical `chunk_size`/`chunk_overlap` ⇒ no LLM call for any of its chunks (subject to per-chunk retryability).
- `error_code` + `next_retry_after` defeat the cache-poisoning failure mode: a failed generation is retryable after a backoff (24h for `llm_unreachable`, 72h for `refusal`, never for `truncated_doc` until the file changes). **The retry-after value is compared against `Date.now()`** — if the system clock is set wrong (NTP slew at boot, manual clock change), retries may misfire. Documented in Open Questions; out of scope to fix in this RFC.
- We deliberately do **not** include a `splitter_fingerprint` field. The justification ("defend against silent langchain boundary regressions") would need to cover the full pre-splitter pipeline (`applyExtractedTextLimit`, `parseFrontmatter`, extraction libraries) plus exact patch version of langchain — too fragile to ship without a real history of false-positives. If a langchain bump silently changes boundaries, the regression surfaces in `kb eval` and the operator bumps `generator` to invalidate the cache. Cheap to add later if needed.

### 3. Embed-time substitution — both insertion paths

`src/faiss-store-adapter.ts` has **two** insertion paths into FAISS, both must be patched, and `src/FaissIndexManager.ts`'s `IndexingEmbeddingDeduper` must be re-keyed:

| path | line | today | after RFC 017 |
|---|---|---|---|
| `FaissStoreAdapter.fromDocuments` | adapter.ts:107 | `FaissStore.fromTexts(docs.map(d => d.pageContent), …)` | `embeddings.embedDocuments(docs.map(embeddingText))`, then `FaissStore.fromVectors(vectors, docs)` |
| `FaissStoreAdapter.addDocumentsWithEmbeddings` | adapter.ts:132 | `this.store.addDocuments([…documents])` | `embeddings.embedDocuments(docs.map(embeddingText))` via the deduper, then `this.store.addVectors(vectors, [...documents])` |
| `IndexingEmbeddingDeduper.embedDocuments` | FaissIndexManager.ts:156 | receives `string[]` and keys cache on `normalizeChunkTextForEmbedding(text)` | text is already `embeddingText(doc)` by the time the deduper sees strings — the adapter applies it upstream. No deduper interface change. |

The substitution happens **inside the adapter, before strings reach the deduper**. The deduper's interface (`embedDocuments(texts: string[])`) stays unchanged. Two chunks with identical text but different prefaces produce different strings before the deduper sees them, so they correctly produce different vectors.

**`addVectors` is not atomic-pair-safe** (round-1 failure-mode #8). The patched paths preserve today's `indexingBatchSize` chunking — we never embed a 10k-chunk batch in one `addVectors` call. After each batch, before declaring success, we assert `store.index.ntotal() === store.docstore.size`. Invariant break refuses the save and re-stages with a clear error.

**BM25 lexical index parity — not a one-line change.** `src/lexical-index.ts` `LexicalIndex.refresh()` (line 244) stores `doc.pageContent` into `SerializedDocument.pageContent`. The query path (line 311+) maps a BM25 hit back to the original verbatim chunk for output. After RFC 017, the **stored representation** for BM25 scoring must use `embeddingText(doc)` (preface-prepended), while the **output representation** continues to be `doc.pageContent` (caller invariant). Implementation: split `SerializedDocument.pageContent` into `searchText` (used by BM25 scoring) and `originalText` (returned to callers). Bump the on-disk lexical index schema version so old serialized indexes are rebuilt rather than misinterpreted. This is the largest single restructure in the RFC and gets its own M0a test surface (round-trip integration test: BM25 hit returns original chunk content).

### 4. LLM call shape

Per chunk, send (via `callChatCompletion` from `src/llm-client.ts`, **with explicit `timeoutMs: 30_000`** — the default is 180_000):

```
system: You generate short retrieval-aware context strings. Reply with the
context only, no preamble, no markdown.

user:
<document>
{{DOCUMENT_BODY}}
</document>

Here is one chunk from the document above:
<chunk>
{{CHUNK_TEXT}}
</chunk>

In ≤ 100 tokens, write a single succinct context paragraph situating this
chunk in the overall document. Include the section heading the chunk lives
under, the surrounding topic, and any pronouns the chunk relies on. Do not
quote the chunk.
```

Hard-coded parameters:
- `temperature`: 0.2.
- `max_tokens`: `KB_CONTEXTUAL_MAX_TOKENS` (env, default 150).
- `timeoutMs`: 30_000.
- Document body truncated to 48_000 characters before being sent.

**Consecutive-failure circuit breaker.** Five consecutive 30s timeouts on the same `kb reindex --with-context` run abort the run with `outcome: failed` and exit code 71 (`EX_OSERR`). A hung llama-cpp slot that's HTTP-reachable but never returns would otherwise cause 5k × 30s = 42-hour stalls; this caps the damage to ~2.5 minutes. The threshold resets on any successful call.

**KV cache reuse on llama-cpp.** `llama-server --parallel 1` (current LRA configuration) holds a single slot whose KV cache persists across HTTP calls when the prompt prefix matches. Per-chunk calls share the `{{DOCUMENT_BODY}}` block; sending document tokens *first* in a stable position lets llama-cpp re-use document tokens. Any intervening request with a different prefix (e.g., a `kb ask` from another shell) evicts the document tokens. The estimated 1-2s per chunk after warm assumes serial sole tenancy; under contention the cost reverts to ~5-8s per chunk. The reindex's runtime estimator (§5) uses the cold-end 8s for the upper bound.

**No batching.** A single mega-prompt asking for all N chunks' contexts at once is rejected: output length scales linearly with N and exceeds `max_tokens` for files with ≥ 5 chunks; a single bad chunk corrupts every preface; KV cache reuse already amortizes the document tokens.

### 5. New CLI: `kb reindex --with-context`

```
kb reindex --with-context [--kb=<name>…] [--force]

  --kb=<name>     Reindex only this KB. Repeat the flag to reindex several.
                  Default: every shelf.
  --force         Skip the LRA-cron-window guard AND the self-runtime-budget guard.
```

(`--dry-run` and `kb reindex` without `--with-context` deferred to follow-up PRs.)

Behavior:

1. **Self-runtime estimator.** Count total chunks across in-scope KBs from existing chunk manifests. Multiply by **8s** (cold-case per-chunk cost — the worst case, not the floor) for the upper bound. If `now + estimated_runtime` would cross 06:00 UTC, refuse to start unless `--force`. Logged as `reindex.start` with `estimated_seconds`.
2. **LRA cron guard.** Check `new Date().getUTCHours()` + `getUTCMinutes()` explicitly. Inside 06:00-10:30 UTC, refuse unless `--force`.
3. **Per-model lock with reindex-appropriate tuning.** `withWriteLock` today has `stale: 10_000`, `update: 5_000` — designed for sub-second MCP writes; would go stale during long `addVectors` batches. The reindex path acquires the lock with extended parameters (`stale: 60_000`, `update: 15_000`) so a busy GC pause or large batch doesn't drop the lock. The reindex holds the lock for the full run. MCP `updateIndex` calls during a reindex will see `WriteLockContentionError`; callers must tolerate this (we adjust the MCP retry envelope from 5 attempts in 10s to 30 attempts over 5 minutes — still fails for the multi-hour case, see Open Questions).
4. **`.reindex.run.json` with PID liveness.** Written at lock acquisition with `pid`, `started_at`, `kbs_in_scope`. On the next startup (any `kb_stats`, `kb reindex`, or trigger watcher invocation), if the file exists, check whether the `pid` is still alive (`process.kill(pid, 0)` semantics). If dead, treat the file as stale, delete it, and emit `reindex.zombie-cleanup` log line. This defeats the zombie-file failure mode where SIGKILL leaves the file claiming `in_progress` forever.
5. **Trigger watcher coordination.** On every poll, the watcher reads `.reindex.run.json`. If present AND `pid` alive, defer — set `pending=true`, do NOT attempt the lock (avoid contention error log noise). If present AND `pid` dead, run the PID-liveness cleanup from step 4. On reindex completion, the watcher drains any deferred triggers.
6. **Per-KB swap and sidecar promotion.** For each KB in scope (not the whole corpus in one transaction):
   a. Walk source files in stable order; for each, re-run `buildChunkDocuments` with contextual retrieval on and re-embed via the §3 path.
   b. Append to a per-KB staging dir under `index.vN+1/<kb-name>/`. Verify `ntotal === docstore.size` invariant after each batch.
   c. **At the end of this KB:** atomic-promote per RFC 014, then write that KB's accumulated sidecars (under `withSidecarLock`). Update `.reindex.run.json` with `last_completed_kb`, `kbs_done`.
   d. Continue to next KB.
   This bounds kill-loss to "one KB's worth of LLM work," not "the entire run." On the deployed corpus that's worst-case ~1 hour, not ~8.
7. **On failure mid-KB.** That KB's staging is abandoned (RFC 014 orphan cleanup). Already-completed KBs are not rolled back. Sidecars from prior KBs survive as cache hits for the next run. The run exits `outcome: partial` if at least one KB completed; `failed` if zero KBs completed.

The trade-off vs v2's single-swap design: per-KB swap means a brief window between KB-N's symlink swap and KB-N's sidecar write where the FAISS index has new vectors and the sidecar file isn't there yet. A SIGKILL in that window leaves `kb_stats` reporting `covered_chunks: 0` for KB-N when it should be 100% — the next reindex regenerates KB-N's prefaces (~one hour of LLM cost). This is the documented cost of using per-KB instead of all-or-nothing semantics. We choose per-KB because losing one KB is recoverable; losing 8 hours is operationally painful enough that operators may avoid the feature.

### 6. Configuration surface

Final environment surface — three vars, not five:

| env var | default | effect |
|---|---|---|
| `KB_CONTEXTUAL_RETRIEVAL` | `off` | master switch; when `off`, the new code paths are no-ops. |
| `KB_CONTEXTUAL_MAX_TOKENS` | `150` | upper bound on preface length passed to the LLM as `max_tokens`. |
| `KB_LLM_ENDPOINT` | (RFC 015 default) | reused unchanged. |

Hard-coded constants (not env vars):
- Document truncation budget: 48_000 chars.
- LRA cron guard window: 06:00-10:30 UTC.
- Retry budget per chunk: 2 attempts with 1s + jitter backoff.
- Per-call timeout: 30 seconds.
- Consecutive-timeout circuit breaker: 5.
- Per-error-type retry-after: 24h for `llm_unreachable`, 72h for `refusal`, never for `truncated_doc`.
- Reindex lock stale/update: 60s / 15s.
- Estimator multiplier: 8s/chunk (cold).

### 7. Observability

`kb_stats` adds a `contextual_preface` sub-object per KB:

```json
{
  "knowledge_bases": [{
    "name": "operating-environment",
    "files": 6, "chunks": 58, "bytes": 40572,
    "contextual_preface": {
      "enabled": true,
      "reindex_state": "completed",
      "last_completed_at": "2026-05-14T22:13:00Z",
      "covered_chunks": 58,
      "null_preface_chunks": 0,
      "coverage_pct": 100.0,
      "cache_bytes": 18211,
      "model": "qwen3.6-35b-a3b",
      "generator": "contextual-preface.v1"
    }
  }]
}
```

Two count fields, not three: `covered_chunks` and `null_preface_chunks`. The "uncovered" remainder (`total_chunks - covered - null_preface`) is derived in the display layer when `reindex_state != completed` (steady-state it's always zero).

`reindex_state ∈ {never, in_progress, completed, partial, failed, stale}` — `stale` is the new value surfaced when `.reindex.run.json` exists but its `pid` is dead (the next operation cleans it up and transitions; while transitioning, `kb_stats` returns `stale`). `in_progress` means a live PID is currently holding the lock.

`reindex_state` transitions are:
- `never` → `in_progress` (lock acquired)
- `in_progress` → `completed` (clean exit, all KBs swapped) or `partial` (some KBs swapped, others failed) or `failed` (zero KBs swapped) or `stale` (process dead, file present)
- `stale` → `never` or prior state (on next operation's cleanup pass)

Canonical log lines (`src/canonical-log.ts`, all using `took_ms` per the existing schema):

- `contextual-preface.resolve` per file — fields: `source`, `chunks`, `cache_hits`, `llm_calls`, `failures`, `took_ms`.
- `contextual-preface.llm-call` per call — fields: `source`, `chunk_index`, `took_ms`, `prompt_tokens`, `completion_tokens`, `outcome` (`success` | `truncated_doc` | `retry` | `failure_unreachable` | `failure_malformed` | `failure_refusal` | `failure_circuit_breaker`).
- `reindex.start` — fields: `kbs`, `estimated_chunks`, `estimated_seconds`, `guard_now_utc`.
- `reindex.kb-completed` per KB — fields: `kb`, `files`, `cache_hits`, `llm_calls`, `failures`, `took_ms`, `swap_performed`.
- `reindex.exit` — fields: `outcome` (`completed` | `partial` | `tempfail` | `failed`), `kbs_completed`, `kbs_attempted`, `took_ms`.
- `reindex.zombie-cleanup` — fields: `prior_pid`, `prior_started_at`, `prior_kbs_done`.

(`reindex.heartbeat` cut — `reindex.kb-completed` cadence is sufficient; `.reindex.run.json` is updated continuously for fast-failure visibility.)

New `KBError` codes — **four**, not seven (LLM-side variants collapse to one code with `outcome` discriminator on the log line):
- `PREFACE_LLM_FAILURE` (category: `external`)
- `PREFACE_SIDECAR_CORRUPT` (category: `internal`)
- `REINDEX_LOCK_HELD` (category: `validation`)
- `REINDEX_BUDGET_EXCEEDED` (category: `validation`)

The `external` category itself is new — added to `CanonicalErrorCategory` in `src/canonical-log.ts` as part of M0a. Without that addition, `classifyCanonicalError` collapses all new codes to `unknown/INTERNAL`.

## Failure modes

| failure | detection | response |
|---|---|---|
| LLM endpoint unreachable | `callChatCompletion` throws connection error | retry up to 2 times with 1s + jitter; on final failure, sidecar entry buffered (and written on per-KB swap) with `error_code: "llm_unreachable"`, `next_retry_after: now + 24h`. Chunk embeds verbatim. |
| LLM returns empty / malformed | response content empty or > `MAX_TOKENS * 4` chars | log `warn`; `next_retry_after` = now + 1h. |
| LLM returns a refusal | response begins with `"I cannot"`, `"As an AI"`, etc. | failure; `next_retry_after` = now + 72h. |
| Document exceeds 48k char budget | `len(documentBody) > 48_000` | truncate to leading 48k chars; emit `outcome: truncated_doc`; `next_retry_after` = never until file changes. |
| **Consecutive LLM timeouts (deadlocked slot)** | 5 consecutive 30s timeouts on the same run | abort the run with `outcome: failed`, exit code 71. Per-KB swaps already performed survive. |
| Source file mutated during ingest (narrow window) | post-LLM `fs.stat` shows mtime/size changed | discard prefaces for this file; emit `RetryableError`. **Note: this only narrows the window — a mutation between the post-stat and `addVectors` completion still results in a stale-content vector. The next ingest cycle reconciles via `documentHash` diff. The invariant is "eventually consistent," not "no stale vector ever visible."** |
| Sidecar JSON corrupt / partial | `JSON.parse` throws | treat as full cache miss for this file; rewrite. Log `PREFACE_SIDECAR_CORRUPT`. |
| `addVectors` partial-failure | post-batch `ntotal !== docstore.size` invariant | refuse to save the staging KB; abort the KB with `outcome: partial`. Already-completed KBs survive. |
| **Cross-model sidecar collision** | two processes writing to `.contextual-prefaces/` simultaneously | `withSidecarLock` from `src/write-lock.ts` (the same primitive RFC 016 uses for docstore CAS) serializes the writes. |
| Reindex lock held by another PID | `withWriteLock(modelDir)` fails after extended retry envelope | exit code 73 (`EX_LOCK`) with the holder's PID. |
| **Reindex zombie (`.reindex.run.json` from SIGKILL run)** | startup check: file present, `process.kill(pid, 0)` throws | delete the file, emit `reindex.zombie-cleanup`, treat state as `never` (or the last successfully-completed state from prior runs). |
| **Watcher TOCTOU on `.reindex.run.json`** | watcher reads file → file deleted by completing reindex between read and lock attempt | watcher's lock attempt succeeds; no deadlock. Watcher proceeds with `updateIndex`. Acceptable race. |
| SIGKILL between KB symlink swap and KB sidecar write | next startup: `kb_stats` shows `covered_chunks: 0` for KB-N when the index has new vectors | the next reindex regenerates KB-N's prefaces. Cost: one KB's worth of LLM calls. Documented in §5 trade-off. |
| Clock skew defeats `next_retry_after` | NTP slew, manual clock change, container clock drift | retries may fire too early (forward jump) or never (backward jump); the cache key `chunkHash` is stable, so a forward-jump retry just re-burns the LLM. Documented in Open Questions; not fatal. |
| LRA cron starts during a reindex | `now > guard_window_start_utc` at the top of each KB iteration | finish the current file's batch, exit with `outcome: tempfail` and exit code 75. KBs already swapped survive. Operator re-runs after 10:30 UTC. |
| Cache poisoned by a single bad preface | per-error `next_retry_after` budget; `generator` version bump for global invalidation | future runs retry expired entries. Per-file invalidate CLI deferred to follow-up. |

## Migration / rollout

**M0a — Preface module + insertion-path patches** (one PR).
- `src/contextual-preface.ts` (cache, LLM call, sidecar IO under `withSidecarLock`, consecutive-timeout circuit breaker, `embeddingText` helper).
- Patches both `FaissStoreAdapter.fromDocuments` and `FaissStoreAdapter.addDocumentsWithEmbeddings` to substitute `embeddingText` upstream of the deduper.
- Patches `LexicalIndex` to split `searchText` from `originalText` in serialization; bumps lexical schema version; tests BM25 round-trip preserves original chunk content.
- Adds `KBError` codes (4 new) + `external` category to `CanonicalErrorCategory`.
- Adds `kb_stats` schema (two-count + `reindex_state` enum).
- Unit tests: cache hit/miss; sidecar `withSidecarLock` arbitration; `next_retry_after` enforcement; two-chunks-same-text-different-preface → two FAISS vectors; `ntotal === docstore.size` invariant; TZ guard boundaries; consecutive-timeout breaker; BM25 search/original split.
- Integration test: byte-identical docstore content with feature on and off.
- Default: `KB_CONTEXTUAL_RETRIEVAL=off`. New code paths are no-ops.

Note on M0a testability: `fromDocuments` is only exercised end-to-end on a fresh-index creation, which today requires deleting `${FAISS_INDEX_PATH}/models/<id>/` and triggering rebuild. The M0a unit test exercises the adapter directly with preface-bearing documents; the full e2e cycle through `buildChunkDocuments → buildIngestQueue → fromDocuments` runs in M0b's CLI integration test. The contract is asserted; the end-to-end exercise lands one PR later.

**M0b — `kb reindex --with-context` CLI** (one PR).
- New `src/cli-reindex.ts` + `SUBCOMMANDS` registration.
- LRA cron guard with `getUTCHours()` + `getUTCMinutes()`; self-runtime estimator with 8s/chunk multiplier; `.reindex.run.json` with PID liveness; per-KB swap + sidecar promotion.
- Lock acquisition uses extended `withWriteLock` parameters (`stale: 60_000`, `update: 15_000`) for the multi-hour hold.
- Trigger watcher coordination (`.reindex.run.json` consult; zombie cleanup).
- Run-level status file + canonical log lines.
- Integration test against a fake llama-server: full reindex of a 3-file fixture KB; assert per-KB swap; assert sidecar parity.
- End-to-end test of M0a's `fromDocuments` path via the CLI on a fresh-index fixture.

**M0c — `kb eval --compare-index`** (one PR, gating M1).
- Note: this is a **medium** lift, not a trivial extension. Today's `runEval` resolves one `FaissIndexManager` via `resolveActiveModel`. M0c needs a low-level load path that bypasses the symlink (loads from `index.vN` and `index.vN+1` directly), structural extension to `EvalArgs`, `parseEvalArgs`, `runEval`, and a per-query diff reporter.
- Without M0c, M1's go/no-go decision reduces to operator eyeballing — too weak a signal for committing to M2's GPU spend. Therefore M0c is on the critical path, not a "nice-to-have extension."

**M1 — Canary shelf** (operator-driven, post-M0c).
- `KB_CONTEXTUAL_RETRIEVAL=on kb reindex --with-context --kb=operating-environment`.
- `kb eval --compare-index --before=<v_pre> --after=<v_post> --fixture=…` reports recall delta.
- If recall improves measurably, proceed. If not, revert.

**M2 — Full reindex** (one operator session).
- `kb reindex --with-context` (all shelves).
- Self-runtime estimator computes the budget upfront (`8s × N`); refuses if it would cross 06:00 UTC.
- Estimated cost on the deployed corpus: ~5k-15k chunks total. **Cold case (KV-cache evicted, 8s/chunk): up to 33 hours for the upper bound.** **Warm case (sole-tenant, 1-2s/chunk): 1-8 hours.** Even the warm case fits the 12h window comfortably; the cold case requires staging across multiple windows. The estimator refuses to start a single-window run that wouldn't fit.
- Per-KB swap (§5 step 6) means a kill mid-run loses only the current KB's work, not the whole run.
- **MCP callers during M2 will see `WriteLockContentionError` for ingestion paths.** The MCP retry envelope is extended in M0b (5×10s → 30×5min) but multi-hour reindexes still exceed it. Operators should expect ingestion to pause during M2; the trigger watcher's deferred-trigger drain (§5 step 5) catches up after the lock releases.

**M3 — Default to on** (separate PR, later). Out of scope for this RFC.

Rollback path: clear `KB_CONTEXTUAL_RETRIEVAL`. Existing FAISS indexes built without prefaces remain queryable throughout. Per-KB swaps mean a mid-M2 abort leaves some shelves on the new index and others on the old — both states are valid and queryable. The mixed-corpus hazard (different prefixes in the embedding text across two halves of the corpus) is real and documented; the operator either completes M2 in a later window or accepts the mixed-quality state.

## Open questions

- **Empirical probes deferred.** Several round-1 and round-2 critic claims are empirical (KV-cache warm latency on real hardware, M2's runtime upper bound, the BM25 + dense lift on `nomic-embed-text` specifically, post-swap sidecar-write window timing). User explicitly chose to skip `design-experimenter`; these probes happen as part of M0a/M0b implementation PRs with concrete benchmark logs.
- **Monotonic clock for `next_retry_after`.** The current design uses wall-clock `Date.now()`. A backward NTP slew would make a retry never happen; a forward jump would make it happen too early. Mitigations (monotonic-clock anchoring, max-jump heuristics) all add complexity. Out of scope for the first cut; documented for future work if poisoning becomes observable.
- **Per-file cache invalidation CLI.** Manual cache surgery today requires `rm` or a `generator` version bump (global). A targeted `kb contextual-cache invalidate --source=<path>` is a low-leverage follow-up.
- **MCP retry envelope vs reindex hold time.** The extended retry envelope (30 attempts over 5 minutes) reduces noise but doesn't cover multi-hour reindexes. A more principled fix is to make the MCP `updateIndex` path queue triggers (write to a journal file the watcher drains post-reindex) rather than fail-fast on lock contention. Deferred to a follow-up RFC.

## Critic feedback incorporated

- **Round 1 (operability-reviewer, delivery-pragmatist, design-minimalist, failure-mode-analyst).** See git history of this file for v1 → v2 deltas. Major changes: `elapsed_ms` → `took_ms`; run-level status file; both insertion paths patched; per-error retry-after; deduper re-key; M0 split into M0a/M0b/M0c; sidecar-after-swap ordering; config surface reduced from 5 to 3 env vars.

- **Round 2 (same 4 critics, v2 → v3).** Incorporated:
  - **Per-KB swap, not single end-of-run swap** (delivery-pragmatist + failure-mode #5 OOM + failure-mode #1 kill-loss). Bounds kill-loss to ~1 hour, not ~8.
  - **`withSidecarLock` around `.contextual-prefaces/` writes** (failure-mode #2 cross-model sidecar collision). Uses the existing primitive from RFC 016.
  - **PID liveness check on `.reindex.run.json`** (failure-mode #4 zombie file + operability #3 partial fix). `process.kill(pid, 0)` on startup; `stale` state in `reindex_state` enum.
  - **Consecutive-timeout circuit breaker** (failure-mode #8 deadlocked LLM slot). 5 consecutive 30s timeouts abort the run.
  - **Reindex-path lock tuning** (operability HIGH #1, delivery MEDIUM). `stale: 60_000`, `update: 15_000` for the multi-hour hold.
  - **Estimator uses 8s/chunk (cold-case ceiling), not 5s** (operability MEDIUM). Refuses runs that would cross the LRA window.
  - **LexicalIndex patch is restructuring, not one-line** (delivery HIGH #2). Split `searchText` from `originalText`; bump lexical schema; round-trip test on M0a.
  - **M0c is a medium lift on the critical path** (delivery MEDIUM #3). Updated milestone description.
  - **MCP `updateIndex` retry envelope during reindex** (delivery MEDIUM #4). Extended to 30×5min in M0b; multi-hour case acknowledged in Open Questions.
  - **Post-LLM mtime/size race is eventually-consistent, not prevented** (failure-mode #7). Prose in §1 + Failure modes table corrected; invariant accurately stated.
  - **`embedded_into_index_version` cut** (design-minimalist + failure-mode #2 race). Redundant with sidecar-after-swap ordering; introduced a new readlink race.
  - **`uncovered_chunks` derived in display, not a named field** (design-minimalist). Steady-state zero.
  - **Co-tenancy guard (slots_idle probe) cut** (design-minimalist). Replaced by the simpler consecutive-timeout breaker; `--force` covers the rare edge case.
  - **`reindex.heartbeat` cut** (design-minimalist + operability LOW). Per-KB cadence + run-level file are enough.
  - **`KBError` codes collapsed: 7 → 4** (design-minimalist + operability). LLM-side variants live in the `outcome` log field, not as separate categories.
  - **`splitter_fingerprint` cut** (design-minimalist + failure-mode coverage gap). The defense was incomplete; ship `chunk_size` + `chunk_overlap` in the cache key, defer fingerprinting to a follow-up if real regressions surface.
  - **`external` `CanonicalErrorCategory` explicitly added in M0a** (operability HIGH #2). Without this, the new codes collapse to `unknown/INTERNAL`.

  Rejected / deferred:
  - **Monotonic-clock anchoring for `next_retry_after`** — added to Open Questions instead. Wall-clock skew is real but the cost of a misfired retry is "one extra LLM call," not corruption.
  - **`KB_CHUNK_KEEP_SEPARATOR` in cache key** (failure-mode splitter coverage). Tied to the `splitter_fingerprint` decision; cut along with it.
  - **Node `--max-old-space-size` floor recommendation** (failure-mode #5 OOM). Per-KB swap (§5 step 6) bounds the in-memory footprint to one KB's worth of prefaces (~1-3 MB), well within default heap. Documentation note only.
  - **Pre-splitter pipeline fingerprinting** (failure-mode splitter coverage). Same reasoning as `splitter_fingerprint` cut.

  No round-3 needed: round 2 mostly produced corrections inside the existing design rather than new directions. The remaining open questions are operational follow-ups, not blockers.
