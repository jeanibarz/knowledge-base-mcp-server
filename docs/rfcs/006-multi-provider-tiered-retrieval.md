# RFC 006 — Multi-provider embedding fusion and fast-vs-quality retrieval tiers

- **Status:** Draft — awaiting approval
- **Author:** Jean Ibarz (drafted by automation)
- **Target:** `jeanibarz/knowledge-base-mcp-server` `main`
- **Related:** RFC 007 (architecture & performance — overlaps on per-KB index sharding)

## 1. Summary

Today the server embeds and retrieves with exactly one provider picked at process start
(`EMBEDDING_PROVIDER` — `src/config.ts:11`) and answers every `retrieve_knowledge` call with
a single vanilla FAISS top-k query (`src/FaissIndexManager.ts:351-365`). That design has two
observable limits: any single embedding model has blind spots, and a single latency profile
cannot serve both "autocomplete-style" callers and "research-grade-recall" callers. This RFC
proposes (a) a multi-index on-disk layout and a query-time weighted RRF fusion layer ported
from LangChain's `EnsembleRetriever` (already transitively installed), and (b) three named
retrieval tiers — `fast`, `balanced`, `deep` — selectable per call via an MCP tool argument,
with an optional cross-encoder rerank for `deep`. Work ships in five milestones with a
committed evaluation harness landing *before* the fusion code so lift claims are measured,
not asserted; `EMBEDDING_PROVIDER` keeps working unchanged across two deprecation cycles.

## 2. Motivation

### 2.1 Single-model brittleness (observed in code)

- The constructor in `src/FaissIndexManager.ts:65-108` hard-wires one embedding backend and
  one model name for the entire process lifetime. The typed `embeddings` field is a union of
  three single classes (`src/FaissIndexManager.ts:67`) — there is no seam for running two
  models over the same corpus.
- The stored-model guard at `src/FaissIndexManager.ts:128-139` deletes `faiss.index`
  whenever the live `modelName` differs from the one persisted in `model_name.txt`
  (`src/FaissIndexManager.ts:23`). So a user who wants to A/B two models today has to rebuild
  the whole index from scratch on every switch — there is no parallel layout.
- `similaritySearch` calls `similaritySearchWithScore(query, k, filter)` on that one index
  (`src/FaissIndexManager.ts:359`). Any recall blind spot of the chosen model becomes a blind
  spot for the tool. Multi-model fusion (e.g. weighted Reciprocal Rank Fusion) is a well-known
  mitigation and is already a shipping primitive in the dependency tree — see §2.3.

### 2.2 One-size-fits-all latency (observed in code and README)

- The `retrieve_knowledge` tool registration at `src/KnowledgeBaseServer.ts:40-49` exposes
  exactly three parameters: `query`, `knowledge_base_name`, `threshold`. There is no way for a
  caller to ask for "fast retrieval now" vs "best retrieval, 1–2 s is fine".
- `handleRetrieveKnowledge` hard-codes `k=10` and the default threshold `2`
  (`src/KnowledgeBaseServer.ts:88`, `src/FaissIndexManager.ts:351`). Every caller pays the
  same cost profile.
- The README documents a single latency regime — `retrieve_knowledge` "performs a semantic
  search using a FAISS index" (`README.md:184`). Callers building, e.g., autocomplete UIs and
  callers building research assistants are quoted the same tool.
- No rerank pass exists anywhere in the repo (confirmed: `grep -r rerank src/` is empty;
  `langchain/dist/retrievers/document_compressors/` ships only `chain_extract.js` and
  `embeddings_filter.js` — no cross-encoder).

### 2.3 What the dependency tree already gives us

- `langchain/retrievers/ensemble.EnsembleRetriever` implements weighted Reciprocal Rank Fusion
  with `c=60` by default and accepts a list of heterogeneous retrievers
  (verified in `node_modules/langchain/dist/retrievers/ensemble.js`, lines implementing
  `_weightedReciprocalRank`). The `langchain` package is already a direct dependency
  (`package.json:24`).
- `@langchain/openai` is installed transitively (`node_modules/@langchain/openai/`) and is
  already imported at `src/FaissIndexManager.ts:7`.
- `@langchain/community/retrievers/bm25` ships a pure-JS BM25 retriever
  (`node_modules/@langchain/community/dist/retrievers/bm25.js`). Out of scope for this RFC
  (dense-only fusion) but flagged as future work in §7.

## 3. Goals

- G1. Allow a user to opt into embedding with **multiple** providers in parallel and fuse
  results at query time, without breaking any existing single-provider deployment.
- G2. Introduce **three named retrieval tiers** (`fast` / `balanced` / `deep`) selectable per
  call, with a sane default and a per-KB override.
- G3. Keep `EMBEDDING_PROVIDER` working unchanged for at least one minor-version window, and
  provide a documented migration from `EMBEDDING_PROVIDER=X` to `EMBEDDING_PROVIDERS=X`.
- G4. Ship a small, checked-in evaluation harness so tier choices are data-backed rather than
  vibes-driven.

## 4. Non-goals

- Replacing FAISS with another vector store (Qdrant, Chroma, pgvector).
- Multi-vector / ColBERT-style retrieval. Flagged in §7 future work.
- Sparse+dense hybrid (BM25 + dense). The building block exists (see §2.3) but is out of
  scope here — this RFC is about dense-only fusion so that a follow-up sparse-hybrid RFC can
  reuse the same multi-retriever seam.
- Query rewriting / HyDE / multi-query generation. The `deep` tier pipeline leaves a slot for
  these (§5.6) but this RFC does not specify them beyond "optional pre-retrieval step".
- Changes to how files are walked, hashed, or chunked — that's RFC 007's territory.

## 5. Proposed design

### 5.1 New on-disk layout

Today (`src/FaissIndexManager.ts:119`, `src/FaissIndexManager.ts:23`):

```
$FAISS_INDEX_PATH/
  faiss.index              # single FAISS store
  faiss.index.json         # (sibling created by FaissStore.save)
  model_name.txt           # last-seen model; mismatch → delete faiss.index
```

Proposed (combined with RFC 007's per-KB isolation — see §5.1.1):

```
$FAISS_INDEX_PATH/
  manifest.json            # { version: 2, shards: [ { id, provider, model, dim, createdAt } ] }
  shards/
    <shard-id>/
      <kb-name>/
        faiss.index          # one FAISS store per (provider/model, KB)
        faiss.index.json
      model.json             # { provider, model, dim, createdAt, updatedAt }
  legacy/
    faiss.index              # v1 layout (auto-migrated on startup, see "Migration")
    model_name.txt
```

Where `<shard-id>` is a filesystem-safe identifier derived from
`<provider>__<sanitized-model-name>` — e.g. `ollama__dengcao-Qwen3-Embedding-0.6B-Q8_0`,
`openai__text-embedding-ada-002`. The sanitization rule: lowercase, replace
`[^a-z0-9_-]` with `-`, collapse runs of `-`. `manifest.json` is the source of truth;
directory scanning is a consistency check.

**Per-file hash sidecars (interaction with `src/FaissIndexManager.ts:203-204` for the
path construction and `src/FaissIndexManager.ts:269` for the write).**
The current per-file sidecar at `<kb>/.index/<relpath>/<basename>` stores a single SHA-256.
With multiple shards, a file can be "fresh" for one shard (just ingested) but "stale" for a
newly-added shard. The sidecar format therefore becomes JSON keyed on shard id:

```json
{ "hash": "<sha256>", "shards": { "ollama__…": "<ingestedAt>", "openai__…": "<ingestedAt>" } }
```

A shard is considered up-to-date for a file iff `shards[shard-id]` is present **and** the
top-level `hash` matches the current file. M2.2 migrates old plain-string sidecars
automatically on first read (treating them as "up-to-date for whichever shard is currently
configured as `EMBEDDING_PROVIDERS[0]`").

**Crash-safety (pending-marker protocol).** Each shard ingest writes to
`<shard-id>/<kb-name>/faiss.index.pending`; on success the file is atomically renamed to
`faiss.index`. On startup, any `.pending` sibling causes that shard/KB pair to be dropped
from the in-memory view and re-ingested on next `updateAllShards`. This aligns with RFC 007
§6.2.1's pending-manifest pattern and keeps the two RFCs' crash protocols consistent.

**Legacy migration — automatic, with a finite lifetime.** On startup, if
`$FAISS_INDEX_PATH/faiss.index` exists and `manifest.json` does not:

1. The server moves the v1 files into `legacy/` and writes a one-shard manifest recording
   the legacy provider/model (read from `model_name.txt`).
2. The legacy shard is usable by `fast` tier immediately; it is not re-embedded.
3. If the legacy `(provider, model)` is *also* listed in `EMBEDDING_PROVIDERS`, the legacy
   directory is renamed into `shards/<shard-id>/` in place rather than kept parallel — no
   double-indexing (closes F10/skeptical-5).
4. Otherwise, `legacy/` is retained. On *every* startup after that, if every provider in
   `EMBEDDING_PROVIDERS` has a populated shard **and** the most recent shard's
   `updatedAt` is later than `legacy/faiss.index`'s mtime, the server logs
   `legacy shard superseded; remove $FAISS_INDEX_PATH/legacy to reclaim disk` at `warn`.
5. In v0.5.0 (see §8.3), the server deletes `legacy/` automatically on startup if the
   supersede condition in (4) holds.

A dry-run env var `MIGRATE_INDEX_DRY_RUN=1` is honored at step (1) only: logs the
intended operations and exits with code 0 without touching disk.

#### 5.1.1 Composition with RFC 007's per-KB layout

RFC 007 §6.4 proposes `$FAISS_INDEX_PATH/<kb>/faiss.index`. The combined layout above
nests KB directories *inside* each shard directory. Rationale: shard-first is cheaper when
adding a new provider (only touches `shards/<new-shard>/`, never touches existing
`<kb>/` trees), and matches the "a shard is one (provider, model) pair" mental model. If
RFC 007 ships first, its `<kb>/` directories live directly under `$FAISS_INDEX_PATH/`; RFC
006's M1.1 migrates each `<kb>/` into `shards/<legacy-shard-id>/<kb>/`. If RFC 006 ships
first, RFC 007's per-KB work lands inside each shard's directory with no further migration.

**Hard ordering contract:** whichever RFC lands first must write the combined target layout
from day one, with the unused axis collapsed to a single entry (one shard, or one KB). This
is called out in both RFCs' §10 checklists and reviewed jointly before merging either M1.1.

**Coordination owner.** Jean Ibarz is the single maintainer of both RFCs; the joint review
is a single person's responsibility, not a cross-team handoff. Before either M1.1 PR opens,
the author re-reads the sibling RFC's §5.1/§6.4 and writes a one-line "combined-layout
check" in the PR description referencing the specific on-disk paths that would be touched.
If the combined layout differs from what is specified here, this RFC is updated first.

### 5.2 `FaissIndexManager` → `EmbeddingIndexRouter`

The existing class is renamed and split (new files; old file deleted in the same PR):

- `src/embedding/providers.ts` — pure factory: `createEmbeddings(spec: ProviderSpec): Embeddings`. One case per provider. Extracted verbatim from the current `src/FaissIndexManager.ts:71-108` branches.
- `src/embedding/Shard.ts` — encapsulates one FAISS store + its model metadata. Owns
  `load()`, `save()`, `addDocuments()`, `similaritySearchWithScore()`. Thin wrapper over
  current `FaissStore` usage (`src/FaissIndexManager.ts:141-152`, `:251-267`, `:351-365`).
- `src/embedding/EmbeddingIndexRouter.ts` — holds `shards: Map<shardId, Shard>`, exposes
  `updateAllShards(specificKnowledgeBase?)` (replaces `updateIndex`) and
  `retrieve(query, opts)` (new — see §5.5).

`src/KnowledgeBaseServer.ts:13` is the single call site of the current manager; it becomes
the single call site of the router.

### 5.3 Config surface

New environment variables:

| Variable | Example | Meaning |
| --- | --- | --- |
| `EMBEDDING_PROVIDERS` | `ollama,openai` | Comma-separated provider list. If set, takes precedence over `EMBEDDING_PROVIDER`. |
| `EMBEDDING_WEIGHTS` | `0.6,0.4` | Optional per-provider RRF weights, same order as `EMBEDDING_PROVIDERS`. Default: uniform. |
| `FUSION_STRATEGY` | `rrf` | Fusion algorithm. Only `rrf` in v1. Reserved for `weighted_rrf`, `combsum`. |
| `FUSION_RRF_C` | `60` | RRF constant. Default matches LangChain (`ensemble.js`). |
| `RETRIEVAL_TIER_DEFAULT` | `balanced` | Default tier when the caller omits it. Defaults to `fast` (preserves today's behavior when the user has not opted in). |
| `EMBEDDING_TIMEOUT_MS` | `3000` | Per-provider timeout applied via `AbortSignal` to each `embedQuery` call (see §5.7). |
| `RERANK_PROVIDER` | `ollama` \| `jina` \| `none` | Cross-encoder backend for `deep` tier. v1 ships `ollama` (reuses `OLLAMA_BASE_URL`) and `jina` (remote API). Default `none` (deep tier falls back to balanced — see §5.6). HuggingFace-hosted rerank was dropped from v1 scope (see §6.5). |
| `RERANK_MODEL` | `xitao/bge-reranker-v2-m3` | Model id for the rerank backend. |
| `RERANK_API_KEY` | `…` | Only read when `RERANK_PROVIDER=jina`. |

Existing `EMBEDDING_PROVIDER` (`src/config.ts:11`) stays as the single-provider fallback. If
both `EMBEDDING_PROVIDER` and `EMBEDDING_PROVIDERS` are set, `EMBEDDING_PROVIDERS` wins and
we log a deprecation warning naming the next minor version in which
`EMBEDDING_PROVIDER` will be removed (§8.3).

`src/config.ts` grows (validation rules are **part of the contract**, not an afterthought —
M2.1 tests cover each):

```ts
export const EMBEDDING_PROVIDERS = parseProviders(
  process.env.EMBEDDING_PROVIDERS ?? process.env.EMBEDDING_PROVIDER ?? 'huggingface'
);
// parseProviders: split, trim, drop empty; throw if any token is not in the supported set.

export const EMBEDDING_WEIGHTS = parseWeights(process.env.EMBEDDING_WEIGHTS, EMBEDDING_PROVIDERS.length);
// parseWeights contract:
//   - undefined/empty → undefined (router applies uniform weights)
//   - length mismatch → throw "EMBEDDING_WEIGHTS has N values, expected M (matches EMBEDDING_PROVIDERS cardinality)"
//   - any NaN, ≤0, or non-finite → throw with index and value
//   - weights are NOT required to sum to 1 (RRF normalizes internally)

export const FUSION_STRATEGY = (process.env.FUSION_STRATEGY ?? 'rrf') as 'rrf';
export const FUSION_RRF_C = Number(process.env.FUSION_RRF_C ?? 60);
export const RETRIEVAL_TIER_DEFAULT = (process.env.RETRIEVAL_TIER_DEFAULT
  ?? 'fast') as 'fast' | 'balanced' | 'deep';
export const EMBEDDING_TIMEOUT_MS = Number(process.env.EMBEDDING_TIMEOUT_MS ?? 3000);
export const RERANK_PROVIDER = (process.env.RERANK_PROVIDER ?? 'none') as
  'none' | 'ollama' | 'jina';
export const RERANK_MODEL = process.env.RERANK_MODEL;
```

`smithery.yaml:26` enum (`["huggingface", "ollama"]`) is extended to match — a separate
stanza for `providers: string[]` is added. Backward-compatible: old Smithery configs with a
single `embeddingProvider` continue to work unmodified.

### 5.4 MCP tool argument surface

`src/KnowledgeBaseServer.ts:40-49` is extended. The Zod enum for `tier` is the single
knob advertised to clients across milestones — but only values that are actually
supported at the current milestone are listed, to avoid ever advertising a value the tool
would throw on (closes F5). Release timeline:

- After M3 merges: `tier: z.enum(['fast', 'balanced']).optional()`
- After M4 merges: `tier: z.enum(['fast', 'balanced', 'deep']).optional()`

The end-state schema adds:

```ts
tier: z.enum(['fast', 'balanced', 'deep']).optional()
  .describe('Retrieval tier. fast = single-provider top-k. balanced = fused multi-provider top-k. deep = fused + cross-encoder rerank. Default: RETRIEVAL_TIER_DEFAULT.'),
top_k: z.number().int().positive().max(100).optional()
  .describe('Number of chunks to return. Defaults to 10.'),
max_distance: z.number().positive().optional()
  .describe('Legacy fast-tier-only L2 distance ceiling. Ignored by balanced/deep tiers. Replaces the old `threshold` argument when used with fast.'),
min_rrf_score: z.number().positive().optional()
  .describe('Fused-tier RRF score floor. Ignored by fast tier. Use with balanced or deep.'),
threshold: z.number().optional()
  .describe('DEPRECATED. Alias for max_distance on fast tier, min_rrf_score on balanced/deep. Logs a deprecation warning. Will be removed in v0.4.0 (see RFC 006 §8.3).'),
```

The two typed arguments close §5.5.3 / skeptical-6 (§7.3 Q4). If a caller passes the wrong
one for the active tier (e.g. `max_distance` with `balanced`), the tool returns a non-error
`CallToolResult` with the argument silently ignored **and** logs a `warn` naming the
correct arg; it does *not* fail the request, to preserve the additive-schema contract of
MCP tools.

The hard-coded `k=10` at `src/KnowledgeBaseServer.ts:88` is replaced by
`args.top_k ?? 10`.

**Per-KB default override.** A knowledge base directory may contain an optional
`.kb-config.json` (the leading dot is mandatory — files without it would be embedded as
knowledge content, see `src/utils.ts:27` and `src/FaissIndexManager.ts:191` which already
skip dotfiles):

```json
{ "defaultTier": "balanced", "topK": 20 }
```

The loader is `src/embedding/kbConfig.ts` (new). When present, it overrides the
env-level `RETRIEVAL_TIER_DEFAULT` *only when the caller did not pass an explicit `tier`*.
Caller-supplied `tier` always wins.

**No stat-per-query.** Closing skeptical-7: per-KB config is loaded once at server startup
and on SIGHUP. A new MCP tool `reload_config` is added in M3.4 with this schema:

```ts
mcp.tool(
  'reload_config',
  'Re-reads per-KB .kb-config.json files from disk. Does not re-read environment variables — restart the server for env changes. Returns a summary of which KBs were reloaded and any parse errors.',
  {},  // no arguments
  async () => this.handleReloadConfig()
);
```

Return shape (as `TextContent` JSON):

```json
{
  "reloaded": ["company", "it_support"],
  "errors": [
    { "kb": "onboarding", "error": "SyntaxError: Unexpected token in JSON at position 42" }
  ]
}
```

Parse errors on any one KB do not fail the call — the remaining KBs reload successfully
and the broken one keeps its last-known-good config in memory. mtime caching is
explicitly **not** used — filesystems with coarse mtime resolution (NFS, Windows,
bind-mounted containers) would produce stale hits.

### 5.5 Query-time fusion

#### 5.5.1 `retrieve()` return shape (the contract)

Closes F1. `EmbeddingIndexRouter.retrieve(query, opts)` returns:

```ts
type RetrievalResult = {
  doc: Document;            // @langchain/core Document, unchanged
  score: number;            // primary score for the caller's chosen tier:
                            //   fast     → raw FAISS L2 distance (lower = better)
                            //   balanced → fused RRF score (higher = better)
                            //   deep     → rerank score if reranker succeeded,
                            //              else fused RRF score
  tierUsed: 'fast' | 'balanced' | 'deep';  // may differ from requested tier (see §5.6 fallback)
  fusedScore?: number;      // always present on balanced/deep
  perShardScores?: Record<string, number>; // shard-id → raw L2 (balanced/deep only).
                                           // Special key 'legacy' is used when the result
                                           // came from $FAISS_INDEX_PATH/legacy/ and the
                                           // legacy shard was kept parallel (§5.1 step 4).
  rerankScore?: number;     // present only on deep with a working reranker
};
```

`src/KnowledgeBaseServer.ts` line 99 (`doc.score.toFixed(2)`) continues to read `.score`.
The score label in the markdown response (`**Score:**`) is annotated with `tierUsed` to
avoid user confusion over what the number means:

```
**Score (balanced, fused RRF):** 0.0321
```

#### 5.5.2 Algorithm — weighted Reciprocal Rank Fusion

For each provider `i ∈ [1..P]` with weight `w_i` and retrieved ranked list
`L_i = [d_{i,1}, d_{i,2}, … d_{i,N}]`:

```
score(d) = Σ_i  w_i / (c + rank_i(d))
```

where `c = FUSION_RRF_C` (default 60) and `rank_i(d) = N+1` if `d ∉ L_i` (i.e. absent
documents don't contribute). Documents are deduplicated by a key that is unambiguous across
the project's chunking rules (closes F6):

```ts
// Dedup key: (kb, source, chunkIndex) when available, falling back to content hash.
function dedupKey(doc: Document): string {
  const { knowledgeBase, source, chunkIndex } = doc.metadata;
  if (knowledgeBase && source && chunkIndex !== undefined) {
    return `${knowledgeBase}::${source}::${chunkIndex}`;
  }
  return `${source ?? '?'}::sha1(pageContent)`;
}
```

This requires `chunkIndex` and `knowledgeBase` to be written onto chunk metadata during
ingest. M1.3 adds them in `Shard.addDocuments` — it's a two-line change to the existing
splitter call at `src/FaissIndexManager.ts:235-240`. The fallback branch is for documents
ingested before the metadata was added (i.e. the `legacy/` shard) and is tested in M3.1.

**Cross-KB scope.** When `knowledge_base_name` is omitted (all-KBs search), two KBs with
the same `source` path are extremely unlikely (sources carry absolute paths); and even if
it happened, treating them as distinct is correct — the caller did not ask for dedup
across KBs. The `knowledgeBase` prefix in the key makes this explicit.

**Chunker invariant.** `chunkIndex` is only a safe dedup key if every shard in the same
manifest was ingested with the same chunker configuration. The contract: all shards in one
`manifest.json` share the same `MarkdownTextSplitter` parameters
(`chunkSize`, `chunkOverlap`, `keepSeparator`) that were live at ingest time. If the
chunker config ever changes, the manifest version bumps and **every** shard is rebuilt
from scratch. M1.3 captures the chunker fingerprint in each shard's `model.json`
(`chunkerConfig` field) so a mismatch is detectable at load time and the offending shard
is refused with a clear error message rather than silently corrupting fusion.

**Complexity.** `O(P · N)` time, `O(P · N)` memory for the working score map — P is small
(1–3 in practice), so this is dominated by the P parallel embedding calls + P parallel FAISS
queries, not by the fusion itself. Parallelism is via `Promise.all` (pattern already used in
`langchain/dist/retrievers/ensemble.js`, the `_rankFusion` method).

#### 5.5.3 Why not build on `EnsembleRetriever` directly

`EnsembleRetriever` dedupes by `pageContent` alone and discards scores (returns
`Document[]`). Both break our contract — the MCP tool response includes per-result scores
(`src/KnowledgeBaseServer.ts:99`) and chunk-overlap dedup needs metadata. So we reuse its RRF
math (copy the `_weightedReciprocalRank` method, ~25 lines in source, as
`src/embedding/rrf.ts` with a pluggable keyFn and score-preserving output) rather than
extending the class. The copy is attributed in the file header.

#### 5.5.4 Threshold semantics — resolved by typed arguments

Previously a single `threshold` argument carried two incompatible meanings. §5.4 now
exposes two typed arguments (`max_distance`, `min_rrf_score`) with a back-compat alias on
the legacy `threshold`. The router's filter logic is:

- `fast` tier: apply `max_distance` as FAISS L2 ceiling, matching today's
  `src/FaissIndexManager.ts:356` filter semantics.
- `balanced` / `deep`: apply `min_rrf_score` post-fusion on the fused RRF score.

Default values (neither argument supplied):

- Fast: preserve today's `threshold = 2` default from `src/FaissIndexManager.ts:351`.
- Balanced/Deep: no floor (`min_rrf_score = 0`); the `top_k` cap is the only limit.

A calibrated default for `min_rrf_score` will be added in a follow-up PR after the §5.8
harness produces per-tier score distributions.

### 5.6 Tier definitions

| Tier | Retrieval steps | Typical latency (self-hosted Ollama + 1 remote) |
| --- | --- | --- |
| `fast` | 1 × embedding call (first configured provider only) → FAISS top-k → threshold filter. Equivalent to today's code path. | 30–100 ms |
| `balanced` | P × parallel embedding calls → P × parallel FAISS top-N (N = 2k by default) → weighted RRF → threshold filter → top-k. | 200–600 ms |
| `deep` | Optional query pre-processing (noop in v1) → P × embedding + FAISS top-N → RRF top-M (M = 4k) → cross-encoder rerank → top-k. | 800–2500 ms |

Pre-processing (HyDE, multi-query) is intentionally a noop slot in v1 — the plumbing exists
(`preprocess(query): Promise<string[]>` in `EmbeddingIndexRouter`) but returns `[query]`.
A follow-up RFC can fill it in without reshaping the tier API.

**Rerank provider.** Default `none` means `deep` tier logs a warning and falls back to
`balanced` — we do not want to silently pay for an untested network hop. v1 release ships
only two backends (see §6.5 for why HuggingFace-hosted rerank was dropped):

- `ollama` (**default when a user opts into `deep`**) — calls a local Ollama instance
  against a reranker model (e.g. `xitao/bge-reranker-v2-m3`). Uses the `OLLAMA_BASE_URL`
  already in `src/config.ts:18`. No API-key path, no pay-per-token risk.
- `jina` — calls `https://api.jina.ai/v1/rerank` with `RERANK_API_KEY`. Jina Rerank v2 is a
  pay-per-token API; kept for users who don't run Ollama locally.

The `Reranker` interface makes tokenizer limits an explicit contract so the router can
pre-split or pre-truncate long chunks before calling the backend (closes F9):

```ts
interface Reranker {
  readonly id: string;               // e.g. 'jina:jina-reranker-v2-base-multilingual'
  readonly maxInputTokens: number;   // declared upper bound on a single (query + doc) pair
  readonly truncationStrategy: 'left' | 'right'; // the backend's behavior if we overshoot
  rerank(query: string, docs: Array<{ doc: Document; score: number }>, topK: number):
    Promise<Array<{ doc: Document; score: number }>>;
}
```

`EmbeddingIndexRouter.retrieve` reads `maxInputTokens` before calling `rerank()` and
truncates `doc.pageContent` to a conservative fraction (default `0.7 * maxInputTokens`
characters, treating 1 token ≈ 4 chars) keeping the first `truncationStrategy === 'left'
? start : end` of the text. Exact token counting is out of scope — this is a safety rail,
not an optimization.

New files: `src/embedding/rerank/index.ts` (factory) + `rerank/OllamaReranker.ts` +
`rerank/JinaReranker.ts`.

### 5.7 Failure modes — recommendation: degrade with warning

If one provider errors mid-query (network, rate limit, 4xx):

1. Log at `warn` level with provider id, error class, and whether it was a timeout.
2. Continue fusion over the surviving providers. Renormalize RRF weights over survivors.
3. If **all** providers fail, return an error `CallToolResult` the same way the current
   `handleRetrieveKnowledge` catch block does (`src/KnowledgeBaseServer.ts:114-121`).
4. For `deep` tier, if the reranker fails, fall back to the balanced output (top-k from the
   fused list, already in memory) and log a warning. Do not fail the request just because the
   cross-encoder is down.

A per-provider circuit breaker (open after N consecutive failures, half-open after T seconds)
is deferred — minimal naive short-circuit: a 3s per-provider timeout using `AbortSignal`
passed to each `embedQuery` call, because the `HuggingFaceInferenceEmbeddings` hanging bug
motivated the Ollama provider in the first place (`CHANGELOG.md:19-20`). Timeout is
configurable via `EMBEDDING_TIMEOUT_MS` (default 3000).

### 5.8 Evaluation harness — lands *before* axis B, not after

Closes skeptical-4 (sample-size inadequacy) and re-sequences the milestones
(see §8.1). The harness must exist, run green on baseline, and produce recall numbers
for `fast` **before** `balanced` lands. Otherwise we cannot tell whether fusion
actually helps on this project's corpus.

New files:

- `eval/corpus/` — ≥200 committed markdown files. Sources: author-owned, public-domain
  (Project Gutenberg excerpts), or Creative-Commons-licensed. Target ~2000 chunks at the
  current chunker config.
- `eval/queries.jsonl` — ≥200 hand-curated `{query, relevant_sources[], relevant_chunks?[]}`
  entries. Curation methodology documented in `eval/README.md`: half "known-good" queries
  written by the maintainer after reading the corpus, half synthesized from document titles
  to exercise lexical-vs-semantic edge cases. Every query is manually checked for at least
  one valid relevant doc in the corpus.
- `eval/run.ts` — runs each query against the running server (via the MCP stdio protocol)
  at every tier, computes Recall@k, nDCG@10, MRR@10, and mean+p95 latency.
- `eval/bootstrap.ts` — paired bootstrap resampling (1000 resamples) to produce 95% CI on
  the *difference* between tiers. A "real" improvement is one whose CI does not cross 0.
- `eval/README.md` — how to run, how to add queries, how to interpret bootstrap CIs.
- `eval/baseline.json` — checked-in baseline: per-tier mean + 95% CI, refreshed whenever
  the corpus or `queries.jsonl` changes. CI smoke-tests the `fast` tier only (no API keys
  required) and fails the PR if the bootstrap CI for the diff-vs-baseline on `fast`
  includes a regression worse than `-0.05` absolute Recall@10.

The harness is **not** part of `npm test`; it is invoked as `npm run eval`. CI runs the
smoke-test on PRs that touch `src/embedding/**`. Running the full multi-provider harness
locally requires provider credentials for whichever providers the operator wants measured —
the harness skips providers whose keys are absent and prints which tiers are degraded-valid
as a result. No HuggingFace Inference keys are required — even for `fast` tier on the HF
provider, a user running the harness locally can fall back to Ollama.

### 5.9 Cost / latency table (recall numbers deferred to §5.8 harness)

Closes skeptical-2: the recall column is removed from this draft because the numbers were
directional estimates not grounded in measurements on this project's corpus. The
§5.8 harness is now a M3-blocker (§8.1), so balanced-vs-fast recall will be a measured
number in the PR that enables `balanced`, not a promise in this document.

Order-of-magnitude latency/cost estimates only. All assume `k=10`, warm process. Latency
estimates are consistent with the RFC 007 synthetic corpus benchmarks.

| Config | Query latency | API cost / 1k queries | Disk (shards) |
| --- | --- | --- | --- |
| 1 × ollama local (today, `fast`) | 40–80 ms | $0 | 1 × base |
| 2 × (ollama + openai), `balanced` | 180–350 ms | $0.10–0.50 (openai only) | 2 × base |
| 3 × (ollama + openai + hf), `balanced` | 300–600 ms | $0.10–0.50 + HF free-tier throttling risk | 3 × base |
| 2 × providers + Jina rerank, `deep` | 700–1500 ms | $0.10 + $0.50–1.50 (Jina) | 2 × base |
| 2 × providers + Ollama rerank, `deep` | 400–900 ms | $0 | 2 × base |

"Disk (shards)" means index size; file counts in `.index/` metadata do not change.

## 6. Alternatives considered

### 6.1 A1: Keep one index; switch providers at query time

**Rejected.** Each provider produces embeddings in a different vector space (different
dimensions, different norms). A single FAISS index cannot be probed with a foreign-provider
query vector without either re-embedding the corpus on the fly (prohibitive) or bolting on a
projection layer (research-grade, not ready). The current single-index design with the
model-mismatch-deletes-index guard (`src/FaissIndexManager.ts:128-139`) implicitly confirms
this: the code already knows mixing providers in one index is incorrect.

### 6.2 A2: Do sparse+dense hybrid (BM25 + current dense) instead of dense+dense

**Deferred, not rejected.** `@langchain/community/retrievers/bm25` is already in the tree
(§2.3) and hybrid sparse+dense typically beats dense+dense on recall for the same latency
budget. But BM25 requires an in-memory doc corpus (`BM25Retriever.fromDocuments(docs)` — see
`node_modules/@langchain/community/dist/retrievers/bm25.js:14-16`), which for our
walk-every-file-on-startup model means holding every chunk of every KB in RAM. That is a
separate memory-footprint conversation, and it should follow RFC 007's per-KB indexing work.
Flagged for a follow-up RFC; the `EmbeddingIndexRouter` seam makes slotting it in later a
localized change (one more `shard` implementation that happens to be sparse).

### 6.3 A3: A single "quality" toggle (boolean) instead of three named tiers

**Rejected.** Two named states (`on`/`off`) cannot distinguish "use all my providers but no
rerank" (network-local, moderate cost) from "also rerank" (remote-network, higher cost). The
three-tier split is the smallest set that exposes the two independently expensive knobs
(fusion vs rerank).

### 6.4 A4: Build our own RRF from scratch

**Rejected** (see §5.5.3). The `langchain/retrievers/ensemble.js` implementation is ~25 LoC
of well-exercised code; we copy-adapt the `_weightedReciprocalRank` math into
`src/embedding/rrf.ts` rather than depend on the class.

### 6.5 A5: Ship all three rerank backends in v1 (HuggingFace + Ollama + Jina)

**Rejected in this draft after review.** The `@huggingface/inference` dependency
(`package.json:17`) is already flaky enough that its unreliability was the documented
reason for adding Ollama as an alternative in the first place (`CHANGELOG.md:19-20`). Adding
a *second* HF-hosted network hop — this time on the query-critical path, not just ingest —
would inherit the same failure profile without the Ollama-was-the-backup mitigation. We
keep the `Reranker` interface small enough that a HuggingFace backend can be added later in
one file if the harness shows real lift from rerank **and** the HF Inference reliability
story has improved. For v1, `ollama` (default) + `jina` (remote option) cover the two use
cases that matter: self-hosted and managed.

### 6.6 A6: Split this RFC into 006a (axes A) and 006b (axis B)

**Considered and rejected for doc boundaries; partially adopted for shipping order.** The
skeptical maintainer review raised this point (see review artifacts). The counter-argument:
separating the docs would leave axis B's motivation section orphaned — `deep` only makes
sense in the context of "balanced made multi-provider possible, now we can rerank over the
fused candidate set". Keeping a single RFC preserves the narrative. What we *do* adopt
from the critique: **M4 (rerank / `deep` tier) cannot merge until M5 (harness) has
produced measured `fast`-vs-`balanced` lift ≥ bootstrap-significant**; see §8.1 ordering
contract. If the harness shows fusion doesn't help on this corpus, `deep` is dropped and
axis B ships as just the `fast`/`balanced` tier split with no reranker — which is effectively
the RFC-split outcome the critique asked for, gated on evidence rather than speculation.

## 7. Risks, unknowns, open questions

### 7.1 Risks

- **R1 — Recall regression on single-provider workloads.** If a user sets
  `EMBEDDING_PROVIDERS=ollama,openai` but their OpenAI key is rate-limited, survivors-only
  fusion (§5.7) still deduplicates via the new content-key scheme (§5.5.1), which may rank
  slightly differently than today's single-provider path. Mitigation: the harness (§5.8)
  explicitly runs `single-provider, modern dedup` as a tier to detect this.
- **R2 — Index bloat.** A user with three providers triples on-disk footprint. Mitigation:
  explicit warning at startup logging the per-shard size and the total; the docs call out the
  trade-off in the new "Choosing providers" section of README.
- **R3 — Cross-encoder latency variability.** Jina Rerank p99 can spike above 2 s under load.
  Mitigation: `deep` tier includes a per-request deadline (default 5 s); timeout → fall back
  to balanced (§5.7).

### 7.2 Unknowns

- **U1 — Right default for `RETRIEVAL_TIER_DEFAULT`.** Set to `fast` in this draft to
  preserve today's behavior for users who haven't read this RFC. If Jean wants the opposite
  (surface the new capability by default once the implementation lands), we change one
  constant.
- **U2 — Chunking interaction with rerank.** Current markdown chunker
  (`src/FaissIndexManager.ts:235-240`, `chunkSize: 1000, chunkOverlap: 200`) yields chunks
  that may be too long for some cross-encoders (many bge variants cap at 512 tokens). The
  reranker backends will need to truncate-left or split; the `Reranker` interface hides this.
  Calibration is a harness deliverable.
- **U3 — Concurrency of parallel embed calls.** Some providers (HF free tier) throttle
  aggressively. We assume `Promise.all` is fine for P ≤ 3, but at higher P a small semaphore
  is warranted.

### 7.3 Open questions for Jean

- **Q1.** Should `fast` tier use the *first* listed provider, or a dedicated
  `EMBEDDING_FAST_PROVIDER` knob (with `EMBEDDING_PROVIDERS[0]` as fallback)? Draft chooses
  option 1 for simplicity.
- **Q2.** Is 3-provider config realistic for this project's single-user knowledge-base use
  case, or should the docs cap at 2 and flag 3 as experimental?
- **Q3.** (Closed.) `min_rrf_score` defaults to `0` (no floor) at M3 ship. The M3.6 harness
  run captures the observed fused-score distribution; a calibrated default lands in a
  follow-up patch release only if the distribution shows a clear bimodal split between
  relevant and irrelevant results. Otherwise the default stays `0` and callers trim with
  `top_k`.
- **Q4.** (Closed — `threshold` asymmetry resolved in §5.4 / §5.5.4 by introducing typed
  `max_distance` and `min_rrf_score` arguments with a deprecation-warned legacy alias.)
- **Q5.** The skeptical review suggested splitting the RFC. Draft keeps one RFC and instead
  gates axis B on measured axis A lift (§6.6, §8.1). Jean, confirm this structure works for
  you or tell us to split.

## 8. Rollout plan

### 8.1 Milestones (in order)

The ordering is revised vs the initial draft so that the harness exists before any tier
that needs to demonstrate lift.

1. **M1 — Layout & router refactor, no behavior change.** Introduce
   `manifest.json`, `shards/`, `legacy/`. One-shard manifest equivalent to today.
   `EMBEDDING_PROVIDER` still works; `EMBEDDING_PROVIDERS` is accepted but single-valued.
   All existing tests pass untouched. Independently shippable.
2. **M2 — Multi-provider ingest.** Multi-valued `EMBEDDING_PROVIDERS`; `updateAllShards`
   writes one shard per provider. No query-time fusion yet — `similaritySearch` still hits
   `EMBEDDING_PROVIDERS[0]`. Independently shippable.
3. **M5 — Evaluation harness + baseline.** Moved *before* M3 (closes skeptical-4,
   "measure before claim"). Produces per-tier measured numbers for `fast` against the
   committed corpus; the `fast` baseline becomes the reference for all later lift claims.
4. **M3 — Fusion + `balanced` tier.** `rrf.ts`, `EmbeddingIndexRouter.retrieve`,
   `tier` tool argument, per-KB override. **Merge gate:** M5 harness shows `balanced`
   Recall@10 bootstrap CI does not overlap `fast` baseline to the negative side (i.e. no
   regression). Lift *magnitude* is informational, not gating.
5. **M4 — `deep` tier + rerank backends.** Reranker interface + `ollama` +
   `jina` implementations. `RERANK_PROVIDER` default `none`. **Merge gate:** M5 harness
   shows `deep` Recall@10 bootstrap CI strictly positive vs `balanced`. If the gate fails,
   M4 is abandoned and `deep` is removed from the tool schema — see §6.6.

Each milestone is its own PR. The RFC approval gate is once; the implementation PRs
reference this doc and tick sections of §10.

### 8.2 Feature flag

No runtime feature flag is needed: `EMBEDDING_PROVIDERS` unset → single-provider path → no
new code paths executed at retrieval time. `tier` arg unset → `RETRIEVAL_TIER_DEFAULT` →
`fast` by default. Users opt in by setting either.

### 8.3 Deprecation schedule

- **v0.2.0 (M3 lands):** `EMBEDDING_PROVIDER` works, deprecation warning logged at startup
  if set alongside `EMBEDDING_PROVIDERS`. Legacy `threshold` tool argument works, warns when
  used.
- **v0.3.0:** `EMBEDDING_PROVIDER` still works, deprecation warning at startup whenever it
  is set, even alone. Legacy `threshold` still works, warns.
- **v0.4.0:** `EMBEDDING_PROVIDER` removed. Legacy `threshold` argument removed (the MCP
  tool schema drops it). README migration note points to the one-line change
  (`EMBEDDING_PROVIDER=ollama` → `EMBEDDING_PROVIDERS=ollama`) and the `threshold` →
  `max_distance` / `min_rrf_score` rename.
- **v0.5.0:** Legacy shard directory (`$FAISS_INDEX_PATH/legacy/`) is auto-deleted on
  startup when all providers have populated newer shards (condition in §5.1 step 5).

The "graveyard" risk raised in skeptical-5 is closed: legacy/ has a finite
lifetime with an auto-delete trigger in v0.5.0.

### 8.4 Independent shippability summary

A (multi-provider fusion) lands via M1 → M2 → M3. B (tiers) lands via M3 and M4. M4 is
dependent on M3 (because `deep` consumes `balanced`'s output). M5 can land in parallel with
any of the others once M3 exists. M1 and M2 can merge before any user-visible
tier/fusion work — they make the storage refactor reviewable on its own.

## 9. Success metrics

Numeric recall lift is **not** used as a ship-gate — skeptical-4 argued (correctly) that
hand-curated eval sets at N≤50 can't prove a 10% lift in the presence of noise. Expanding to
N≥200 with paired bootstrap (§5.8) improves the situation, but absolute-recall thresholds
would still be brittle. Instead, the gates are *relative, bootstrap-stable*:

- **Quantitative (measured by `eval/run.ts` + `eval/bootstrap.ts`):**
  - S1 — `fast` tier Recall@10 bootstrap CI on the committed corpus does not regress worse
    than `-0.05` absolute vs the pre-RFC single-provider baseline captured in M5.
  - S2 — `balanced` tier bootstrap CI for (balanced − fast) on Recall@10 does not overlap
    the negative side (no regression on fusion). Magnitude of lift is reported as
    informational.
  - S3 — `deep` tier bootstrap CI for (deep − balanced) on Recall@10 is strictly positive.
    Failing this gate means rerank is abandoned in v1 per §8.1 M4 merge-gate.
  - S4 — `fast` tier latency within ±20% of the RFC 007 measured retrieval latency.
  - S5 — `balanced` tier p95 latency ≤ 600 ms on the committed corpus with two local-ish
    providers (Ollama + HF).
  - S6 — Legacy migration (§5.1) runs to completion on a pre-existing deployment's
    `$FAISS_INDEX_PATH` in < 1 s (no re-embedding; just file moves + manifest write).
- **Qualitative:**
  - S7 — README has a decision table telling a user how to pick a tier.
  - S8 — (Non-blocking, informational only.) A `demo-report` GitHub issue template lands
    in M3. External-user reports of real-world `balanced` lift are tracked against it but
    do *not* gate any milestone — unfalsifiable criteria do not make good ship gates.

## 10. Implementation checklist

Each item is one PR unless noted. Ordering follows §8.1: M1 → M2 → M5 → M3 → M4.

### M1 — Layout & router refactor

- [ ] **M1.1** Add `src/embedding/manifest.ts` with `readManifest`, `writeManifest`,
      and the JSON schema (`{ version: 2, shards: [...] }`). Migrate
      `src/FaissIndexManager.ts:119-152` load logic to consume it. Honor the combined-layout
      contract in §5.1.1 (coordinate with RFC 007 author). **Tests:**
      `src/embedding/manifest.test.ts` covering (a) fresh install (no manifest, no legacy),
      (b) legacy-only install, (c) manifest + shards, (d) corrupt manifest.
- [ ] **M1.2** Split `src/FaissIndexManager.ts:65-108` into `src/embedding/providers.ts`.
      Update `src/FaissIndexManager.ts:5-8` imports. **Tests:** existing
      `src/FaissIndexManager.test.ts` passes unchanged; new
      `src/embedding/providers.test.ts` covers each provider branch and each missing-key
      error path.
- [ ] **M1.3** Introduce `src/embedding/Shard.ts`; rewire `FaissIndexManager` to delegate
      load/save/query. Add `chunkIndex` and `knowledgeBase` to chunk metadata at the splitter
      call site (`src/FaissIndexManager.ts:235-240` analogue). No other behavior change.
- [ ] **M1.4** Rename `FaissIndexManager` → `EmbeddingIndexRouter`
      (`src/embedding/EmbeddingIndexRouter.ts`). Update call site at
      `src/KnowledgeBaseServer.ts:13`. Delete `src/FaissIndexManager.ts`. Keep test file
      path but retarget imports.
- [ ] **M1.5** Pending-marker protocol (§5.1). Each shard write goes to
      `faiss.index.pending`, renamed on success. Startup drops any shard with a stray
      `.pending` sibling. **Tests:** simulate mid-write crash by writing a `.pending` and
      asserting the shard is rebuilt on next `updateAllShards`.
- [ ] **M1.6** Legacy supersede-cleanup logging (§5.1 step 4). When all providers in
      `EMBEDDING_PROVIDERS` have populated shards newer than `legacy/faiss.index`'s mtime,
      log a `warn` naming the `rm -rf` target. **Tests:** fixture with legacy + newer
      shard asserts the log line fires.

### M2 — Multi-provider ingest

- [ ] **M2.1** Parse `EMBEDDING_PROVIDERS`, `EMBEDDING_WEIGHTS`, `EMBEDDING_TIMEOUT_MS` in
      `src/config.ts`. Validation contract per §5.3: throw on weight/provider length
      mismatch, throw on NaN / ≤0 / non-finite weights, throw on unknown provider names.
      **Tests:** `src/config.test.ts` covers single-value, multi-value, mismatched weights,
      non-finite weight, unknown provider name, extra whitespace.
- [ ] **M2.2** `updateAllShards` ingests once per provider in parallel. Per-file sidecars
      upgraded to the JSON format in §5.1 (auto-migrates from plain-string on first read).
      **Tests:** (a) two-provider setup gets the full document set in each shard, (b) old
      plain-string sidecars are accepted and upgraded, (c) adding a new provider to an
      existing KB re-ingests every file into the new shard only (existing shards untouched).
- [ ] **M2.3** `similaritySearch` still uses `EMBEDDING_PROVIDERS[0]` — no fusion yet.
      Single-provider behavior on a multi-shard store is identical to today's single-index
      behavior. Regression tested against the existing `src/FaissIndexManager.test.ts`.

### M5 — Evaluation harness (runs before M3 per §8.1)

- [ ] **M5.1** `eval/corpus/` with ≥200 committed markdown files (licenses documented in
      `eval/README.md`). `eval/queries.jsonl` with ≥200 hand-curated queries.
- [ ] **M5.2** `eval/run.ts` spawns the server as a child process, issues MCP calls over
      stdio, collects Recall@10, nDCG@10, MRR@10, mean + p95 latency. `npm run eval`.
- [ ] **M5.3** `eval/bootstrap.ts` paired bootstrap resampling (1000 resamples) producing
      95% CI on per-tier metrics and on tier-vs-tier diffs.
- [ ] **M5.4** `eval/baseline.json` checked in with `fast`-tier-only baseline. CI job
      `eval-smoke` runs `fast` tier against baseline and fails the PR on bootstrap CI
      regression worse than `-0.05` absolute Recall@10 (S1 gate).
- [ ] **M5.5** README: "Running the eval harness" section. CHANGELOG entry.

### M3 — Fusion + `balanced` tier (gated on M5 showing no `fast` regression)

- [ ] **M3.1** `src/embedding/rrf.ts` — port of `_weightedReciprocalRank` with pluggable
      dedup key (§5.5.2). **Tests:** table-driven against fixture rankings, including the
      fallback-dedup branch for metadata-less documents.
- [ ] **M3.2** `retrieve(query, { tier, topK, maxDistance, minRrfScore })` in
      `EmbeddingIndexRouter`. Wire `fast` (single-shard, applies `maxDistance`) and
      `balanced` (fused, applies `minRrfScore`). `deep` falls back to `balanced` with a
      warning — *not* "throws not implemented". Return shape matches §5.5.1.
      **Tests:** integration test hits both tiers and asserts ordering + per-field score
      presence (`fusedScore`, `perShardScores`).
- [ ] **M3.3** Extend `retrieve_knowledge` Zod schema at `src/KnowledgeBaseServer.ts:40-49`
      with `tier` (enum limited to `'fast' | 'balanced'` at this milestone per §5.4) +
      `top_k` + `max_distance` + `min_rrf_score` + legacy `threshold` alias. Update README
      §Usage. **Tests:** mock MCP client calls the tool with each tier and each threshold
      variant.
- [ ] **M3.4** Per-KB `.kb-config.json` loader (load-at-startup, reload via new
      `reload_config` MCP tool — §5.4). **Tests:** missing file, malformed JSON, correct
      precedence (caller > KB > env), reload-on-demand.
- [ ] **M3.5** Legacy-layout auto-migration + `MIGRATE_INDEX_DRY_RUN`. **Tests:** fixture
      directory with v1 layout → migrated in temp dir; `MIGRATE_INDEX_DRY_RUN=1` logs plan
      without touching disk.
- [ ] **M3.6** Re-run `npm run eval` on M3 branch, check in updated `eval/baseline.json`
      with `balanced` results. **Merge gate:** S2 bootstrap CI passes.
- [ ] **M3.7** README: new "Choosing a retrieval tier" section (partial — covers
      `fast` + `balanced`; `deep` added in M4.6). CHANGELOG entry.

### M4 — `deep` tier + rerank (gated on M3 eval showing `balanced` lift)

- [ ] **M4.1** `Reranker` interface + factory in `src/embedding/rerank/index.ts`, including
      `maxInputTokens` and `truncationStrategy` (§5.6).
- [ ] **M4.2** `OllamaReranker`. **Tests:** mock `fetch` to `OLLAMA_BASE_URL`, assert
      truncation of over-long inputs.
- [ ] **M4.3** `JinaReranker`. **Tests:** mock `fetch`, assert request shape and response
      parsing; assert no API key → clean error (not silent fallback).
- [ ] **M4.4** `deep` tier in `retrieve`. Fallback to `balanced` when
      `RERANK_PROVIDER=none` OR reranker throws. Expand tool-schema enum to include
      `'deep'` (per §5.4 end-state). **Tests:** integration test with a fake reranker
      asserts rerank is called with the fused top-M and that the final list respects
      `top_k`; fallback path tested with a throwing reranker.
- [ ] **M4.5** Re-run `npm run eval`, check in updated `eval/baseline.json` with `deep`
      results. **Merge gate:** S3 bootstrap CI passes. If it fails, M4 is reverted and
      `deep` removed from the schema per §6.6.
- [ ] **M4.6** README: "Choosing a retrieval tier" completed with `deep` row and reranker
      setup instructions.

---

*End of RFC 006.*
