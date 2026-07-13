# Data model

Every artifact that survives a process restart lives under either `$KNOWLEDGE_BASES_ROOT_DIR` or `$FAISS_INDEX_PATH`. This page is a current snapshot; if a claim here stops matching the cited source file, the doc is stale.

## On-disk layout

```mermaid
flowchart LR
  subgraph kbs["$KNOWLEDGE_BASES_ROOT_DIR<br/>src/config/paths.ts"]
    direction TB
    subgraph kb1["&lt;kb_name&gt;/  (user-authored)"]
      Source["*.md, *.txt, *.pdf, *.html<br/>plus configured extra extensions"]
      SidecarDir[".index/<br/>(written by this server)"]
      Sidecar["&lt;subdir&gt;/&lt;basename&gt;<br/>one sha256 hex per source file"]
      Source -.sha256.-> Sidecar
    end
    kb2["&lt;other_kb&gt;/"]
  end

  subgraph faiss["$FAISS_INDEX_PATH<br/>src/config/paths.ts"]
    direction TB
    Active["active.txt<br/>active model_id"]
    Models["models/"]
    ModelDir["&lt;model_id&gt;/<br/>provider__filesystem-safe-slug"]
      ModelName["model_name.txt<br/>configured embedding model name"]
      IndexType["index-type.txt<br/>flat, sq8, or hnsw"]
      LastUpdate["last-index-update.json<br/>latest update summary"]
      MetadataSidecar["metadata-sidecar.jsonl<br/>filter fast-path rows"]
      IndexLink["index<br/>symlink to index.vN"]
      Version["index.vN/"]
      Faiss["faiss.index<br/>FAISS binary, when backend=faiss"]
      Hnsw["hnsw.index<br/>HNSW binary, when backend=hnsw"]
      Docs["docstore.json<br/>FAISS LangChain tuple or HNSW JSON docstore"]
      Integrity["integrity.json<br/>backend, index type, hashes, HNSW params"]
      Cas[".docstore-cas/<br/>canonical FAISS docstore payloads"]
      QueryCache["cache/queries/&lt;model_id&gt;/<br/>query embedding cache"]
      DecompositionCache["cache/query-decompositions/<br/>optional decomposition result cache"]
      Legacy["faiss.index/<br/>legacy layout, read fallback"]

    Active --> ModelDir
    Models --> ModelDir
    ModelDir --> ModelName
    ModelDir --> IndexType
    ModelDir --> LastUpdate
    ModelDir --> MetadataSidecar
    ModelDir --> IndexLink
    IndexLink --> Version
    Version --> Faiss
    Version --> Hnsw
    Version --> Docs
    Version --> Integrity
    Docs -.hardlink when FAISS dedup succeeds.-> Cas
    ModelDir --> QueryCache
    Models --> DecompositionCache
    ModelDir -.pre-RFC-014.-> Legacy
  end
```

The two trees are independent (see [`c4-container.md`](./c4-container.md) for lifecycle notes). Hash sidecars travel with the source file, not with the vector index. Deleting `$FAISS_INDEX_PATH/` removes vectors but not source files; startup/update code treats the missing FAISS store as a rebuild signal and may purge stale sidecars before re-embedding. Moving a KB between roots does not orphan vectors for unrelated KBs.

## Artifacts

### Per-file hash sidecar

Written after a successful FAISS save by `writeSidecarHashes` (`src/file-ingest.ts:118-144`), called from `FaissIndexManager.updateIndex` (`src/FaissIndexManager.ts:782-793`). One text file exists per indexed source file; content is a lowercase sha256 hex digest of the source bytes.

| Field | Type | Source |
| --- | --- | --- |
| path | `<kb>/.index/<rel_dir>/<basename>` | derived from `relativePath` at `src/FaissIndexManager.ts:647-659` |
| content | sha256 hex string (64 chars) | `calculateSHA256` at `src/FaissIndexManager.ts:648-650` |
| atomicity | tmp+rename under the sidecar lock | `src/file-ingest.ts:122-132` |

The path structure mirrors the source tree under `<kb>/`: a file at `<kb>/a/b/c.md` gets a sidecar at `<kb>/.index/a/b/c.md`. ADR [`0002-per-file-hash-sidecars.md`](./adr/0002-per-file-hash-sidecars.md) covers why this layout was chosen over a single `hashes.json` manifest.

### Pending sidecar commit manifest

`pending-manifest.json` lives in `models/<model_id>/` while an index-mutating `updateIndex` is between FAISS persistence and sidecar persistence. It records the hash sidecars and chunk manifests that must be written for the saved vectors to be considered committed.

| Field | Type | Meaning |
| --- | --- | --- |
| `schema_version` | `kb.pending-sidecar-commit.v1` or `kb.pending-sidecar-commit.v2` | Parser guard; writers use v2 and readers retain v1 compatibility. |
| `owner` | `{pid, hostname, started_at}` (v2) | Identifies the writer that owns an in-progress save; absent on legacy v1 manifests. |
| `phase` | `save-started` or `save-complete` | Whether the FAISS save has been confirmed. |
| `pending_hash_writes` | array of `{path, hash}` | Absolute hash sidecar paths plus source sha256. |
| `pending_chunk_manifest_writes` | array of `{path, manifest}` | Absolute chunk-manifest sidecar paths plus manifest JSON. |

Normal completion removes the manifest after all sidecars are durable. On startup, recovery runs under the model write lock. `save-complete` rolls forward by writing the sidecars and removing the manifest. A v2 `save-started` manifest with a live owner on the same host is left intact while that writer finishes; ownerless, malformed, dead, or foreign-host manifests are treated conservatively and purge the persisted store and stale sidecars so the next update rebuilds instead of risking duplicate vectors or hashes for missing vectors.

### Model registry

`$FAISS_INDEX_PATH/active.txt` records the active `model_id`; callers can override it with `KB_ACTIVE_MODEL` (`src/active-model.ts:5`, `:26`). Each registered model lives at `$FAISS_INDEX_PATH/models/<model_id>/`, where `<model_id>` is derived from provider and model name (`README.md:102`, `src/active-model.ts:37-43`).

A model is registered only when its directory exists, `model_name.txt` exists, and `.adding` does not exist (`src/active-model.ts:107-127`). `model_name.txt` is written per model during `FaissIndexManager.initialize()` (`src/FaissIndexManager.ts:327-334`) and stores the configured embedding model name, not the derived model id.

### Versioned search-index store

New saves use the RFC 014 layout in each model directory. The active
`index-type.txt` value selects the backend: `flat` and `sq8` use the FAISS
adapter, while `hnsw` uses the HNSW adapter.

```text
models/<model_id>/
  model_name.txt
  index-type.txt
  index -> index.vN
  index.vN/
    faiss.index | hnsw.index
    docstore.json
    integrity.json
  index.vN-1/
    faiss.index | hnsw.index
    docstore.json
    integrity.json
```

`saveFaissStoreAtomic` and `saveHnswIndexAtomic` write the next `index.vN/`, create a temporary symlink, atomically rename it to `index`, and then prune inactive version directories (`src/faiss-store-layout.ts`). The default retention policy keeps the active version plus two inactive retained versions. Operators can set `KB_INDEX_VERSION_RETENTION=<non-negative integer>` to change the inactive-version count; `0` keeps only the active version after a successful save. Pruning reads the active `index` symlink before deleting anything and never removes that target, even if it is outside the newest retained versions. `kb doctor` reports active, inactive, and total version-directory storage so retained-version cost is visible during health checks.

`loadFaissStoreAtomic` and `loadHnswIndexAtomic` pin reads by resolving the `index` symlink once before loading backend files, so the vector index, `docstore.json`, and `integrity.json` come from the same version directory even if another writer swaps the symlink later.

For FAISS models, `faiss.index` is the binary vector index in `faiss-node`'s native format and `docstore.json` is the LangChain docstore sibling emitted by `FaissStore.save`. That FAISS docstore is part of the `$FAISS_INDEX_PATH` code-exec trust boundary because loading attacker-controlled serialized data is unsafe. For HNSW models, `hnsw.index` is the `hnswlib-node` native index and `docstore.json` is the project-owned `kb.hnsw-docstore.v1` JSON payload. `integrity.json` records the backend, index type, file hashes, embedding canary, and HNSW tuning fields when applicable. See [`threat-model.md`](./threat-model.md).

### Docstore CAS

For FAISS saves, `$FAISS_INDEX_PATH/.docstore-cas/` stores canonicalized
`docstore.json` payloads keyed by SHA-256. `saveFaissStoreAtomic` can replace a
per-model `index.vN/docstore.json` with a hardlink to the shared CAS payload so
multiple embedding models over the same chunks do not duplicate the same text
and metadata. CAS writes and garbage collection run under `.docstore-cas/.lock`;
if hardlinking is unsupported or crosses devices, saves fall back to ordinary
per-model `docstore.json` files without changing retrieval behavior.

### Legacy FAISS store

The pre-RFC-014 layout is `models/<model_id>/faiss.index/{faiss.index,docstore.json}`. The loader still falls back to it when the `index` symlink is absent (`src/faiss-store-layout.ts:122-142`). The first successful save under the new layout writes `index.vN/` and leaves the legacy directory untouched as downgrade/rollback slack (`src/FaissIndexManager.ts:765-770`). When both layouts are present, `kb models list` can surface a downgrade hazard derived directly from filesystem state (`src/active-model.ts:129-185`).

### Query embedding cache

`$FAISS_INDEX_PATH/cache/queries/<model_id>/` stores optional query-vector cache
entries. Each query key is a SHA-256 over schema version, `model_id`, and the
normalized query. The vector is stored as `<sha>.f32`; metadata is stored as
`<sha>.meta.json`. The cache is a latency/cost optimization only: read I/O
failures are treated as misses without deleting entries, while entries that
fail parsing, schema, checksum, or value validation are removed and treated as
misses. Operators can disable it with `KB_QUERY_CACHE=off` or per-call CLI
flags where supported.

### Query decomposition cache

When `KB_DECOMPOSE_CACHE_ENABLED=on`,
`$FAISS_INDEX_PATH/cache/query-decompositions/<prefix>/<sha>.json` stores the
subqueries returned by LLM query decomposition. The SHA-256 key covers the
schema version, model id, and normalized query. Each record also includes a
checksum of its subquery list. Invalid or corrupt records are deleted and
treated as misses; writes use a temporary file plus atomic rename.

The disk tier is paired with a process-local LRU. Operators can bound the tiers
with `KB_DECOMPOSE_CACHE_LRU_MAX` (default `256`, where `0` disables the memory
tier) and `KB_DECOMPOSE_CACHE_DISK_MAX_BYTES` (default `67108864`). Oldest disk
entries are removed when the byte budget is exceeded. The cache is an optional
latency/cost optimization and does not change retrieval correctness.
### Model sidecar files

Each model directory can also contain:

- `index-type.txt` — index creation type: `flat`, `sq8`, or `hnsw`.
- `last-index-update.json` — latest sanitized `updateIndex` summary for fresh
  process stats and doctor reports.
- `metadata-sidecar.jsonl` — per-doc metadata rows used to speed filtered search
  before falling back to post-filter overfetch.
- `pending-manifest.json` — crash-recovery manifest between FAISS save and
  sidecar commit.
- `.adding` — temporary sentinel while `kb models add` is in progress.

### Other durable operator artifacts

Not every durable artifact belongs under the two retrieval stores:

- `kb research collect --run-dir=<path>` writes `run.json`, `plan.json`,
  `ledger.json`, `events.jsonl`, and `evidence_packet.md` to the operator-chosen
  run directory.
- `KB_MUTATION_AUDIT_LOG=<path>` writes an append-only mutation audit JSONL file
  outside the KB and FAISS roots when configured.
- `kb llm` profile and managed-service state live under configurable user config,
  state, and systemd directories (`KB_LLM_CONFIG_DIR`, `KB_LLM_STATE_DIR`,
  `KB_LLM_SYSTEMD_USER_DIR`).

## In-memory: chunk metadata schema

`FaissIndexManager.updateIndex` uses one chunk builder for changed-file indexing and full-rebuild fallback (`src/FaissIndexManager.ts:705-709`, `:748-752`). `buildChunkDocuments` splits markdown with `MarkdownTextSplitter`, other ingested extensions with `RecursiveCharacterTextSplitter`, strips YAML frontmatter from page content, and attaches the metadata below to every emitted `Document` (`src/file-ingest.ts:37-104`).

```ts
type ChunkMetadata = {
  source: string;
  relativePath: string;
  knowledgeBase: string;
  extension: string;
  chunkIndex: number;
  tags: string[];
  frontmatter?: LiftedFrontmatter;
  pdf_path?: string;
  contextual_preface?: string;
};
```

### Chunk metadata fields

| Field | Type | Always present? | Source of truth | Wire exposure |
| --- | --- | --- | --- | --- |
| `source` | `string` absolute path | yes | `src/file-ingest.ts:87-95` | visible |
| `relativePath` | `string` POSIX path relative to `$KNOWLEDGE_BASES_ROOT_DIR` | yes | `src/file-ingest.ts:68-72` | visible; used by path filters |
| `knowledgeBase` | `string` KB directory name | yes | `buildChunkDocuments(..., knowledgeBaseName)` at `src/file-ingest.ts:50-54`, `:92-97` | visible |
| `extension` | `string` lowercase extension, including dot | yes | `path.extname(filePath).toLowerCase()` at `src/file-ingest.ts:55`, `:92-98` | visible |
| `chunkIndex` | `number` zero-based ordinal within the source file | yes | loop index at `src/file-ingest.ts:91-99` | visible; formatter uses it as fallback location |
| `tags` | `string[]` | yes | `parseFrontmatter(content)` at `src/file-ingest.ts:68`, `:92-100` | visible |
| `frontmatter` | `LiftedFrontmatter` | no | `liftFrontmatter(frontmatter, filePath)` at `src/file-ingest.ts:242-265`; malformed frontmatter falls back to `{ kb_policy: { no_llm_context: true } }` for LLM-boundary safety | visible after sanitization; `extras` hidden by default |
| `pdf_path` | `string` KB-relative POSIX path | no | `detectSiblingPdfPath` for markdown files at `src/file-ingest.ts:80-101` | visible |
| `contextual_preface` | `string` | no | `resolveContextualPrefaces` when contextual retrieval is enabled in `src/file-ingest.ts` | stored for embedding/lexical input; not a source-content replacement |

### Lifted frontmatter

`liftFrontmatter` is the whitelist for `metadata.frontmatter` (`src/frontmatter-lift.ts:19-56`). String fields are `arxiv_id`, `title`, `authors`, `published`, `ingested_at`, `judge_method`, `metrics_used`, `bias_handling`, `status`, `review_status`, `promote_model`, `tier`, and `last_verified_at`. Typed fields are `relevance_score?: number`, `confidence?: number`, `manual_edits?: boolean`, and `contradicted_by?: string[]`.

Unknown string-valued YAML keys are collected into `frontmatter.extras`; non-string generic keys are dropped with debug logging (`src/frontmatter-lift.ts:131-154`). `sanitizeMetadataForWire` strips `frontmatter.extras` unless `FRONTMATTER_EXTRAS_WIRE_VISIBLE=true` (`src/formatter.ts:34-58`). The stored FAISS docstore keeps the original metadata object; the sanitizer applies at markdown and JSON response formatting time (`src/formatter.ts:66-90`, `:123-140`).

### Sibling PDF path

For markdown chunks only, `detectSiblingPdfPath` looks for a same-stem PDF in the arxiv layout (`<kb>/pdfs/<stem>.pdf`) and then in the same directory as the markdown file. It returns a KB-relative forward-slash path and rejects paths that escape the KB root (`src/frontmatter-lift.ts:189-218`).

## Not persisted

- Raw query text is not written to disk by the retrieval path. Query-cache keys
  are hashes of normalized query text, model id, and schema version; cache values
  are vectors, not raw queries.
- Embedding provider keys (`HUGGINGFACE_API_KEY`, `OPENAI_API_KEY`) are held in `process.env` for the life of the process. They are not written to sidecars, model registry files, or FAISS docstore metadata.
- Retrieval itself has no queue. Operator workflows such as `kb research`,
  mutation audit logging, and `kb llm` profiles write outside the retrieval
  stores only when the operator selects or enables those surfaces.

## Checked against

This page is verified against the following source files. If one of these files moves or its cited lines drift, refresh this doc rather than letting the claim go stale.

- Chunk metadata wire shape: `src/file-ingest.ts:37-104`.
- Frontmatter whitelist + sanitisation: `src/frontmatter-lift.ts:19-218`, `src/formatter.ts:34-90`.
- Atomic FAISS save / pinned load / version retention: `src/faiss-store-layout.ts`.
- HNSW backend files and JSON docstore: `src/hnsw-index-adapter.ts`, `src/faiss-store-layout.ts`.
- Docstore CAS hardlink dedup: `src/docstore-cas.ts`, `src/faiss-store-layout.ts`.
- Query embedding cache: `src/query-cache.ts`.
- Model registry, model sidecars, incomplete-add sentinel: `src/active-model.ts`.
- Sidecar write path: `src/file-ingest.ts:118-144`, `src/FaissIndexManager.ts:782-793`.
- Active-model resolution: `src/active-model.ts:5-26`, `:259-330`.
- Per-model directory and `model_name.txt`: `src/active-model.ts:107-127`, `src/FaissIndexManager.ts:327-334`.
