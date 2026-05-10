# Requirements

- [Retrieval eval command](retrieval-eval.md)

## Indexing

### NFR-INDEX-236: Batched Changed-File Embeddings
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall embed changed-file chunks during `updateIndex` in bounded document batches before saving the FAISS index.
**Rationale:** Batching amortizes embedding-provider round trips for refreshes and cold rebuilds while preserving the existing save-once durability boundary.

**Acceptance Criteria:**
- [x] Given multiple changed files, when their chunks fit within `INDEXING_BATCH_SIZE`, then `updateIndex` shall seed an empty FAISS store with one `fromTexts` call and shall not call `addDocuments` per file.
- [x] Given changed-file chunks exceeding `INDEXING_BATCH_SIZE`, then `updateIndex` shall append the remaining chunks with one `addDocuments` call per bounded batch.
- [x] Given a successful batched update, then `updateIndex` shall persist the FAISS store once and shall write hash sidecars only after that save succeeds.
- [x] Given an invalid or unset `INDEXING_BATCH_SIZE`, then the system shall use conservative provider defaults.
- [x] Given an explicit manager provider, then the default batch size shall be resolved from that manager provider rather than the process-wide provider.

**Linked Tests:** TS-INDEX-236
**Dependencies:** RFC007

## Observability

### FR-OBS-237: Last Index Update Summary
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall expose the latest in-process `updateIndex` run summary through `kb_stats` and `kb doctor`.

**Acceptance Criteria:**
- [x] Given no update has run in the current process, when stats or doctor output is requested, then the latest update status is `never_run`.
- [x] Given an index update runs, when stats are requested, then the payload reports the run scope, model id, timestamps, duration, file counters, chunk counters, save outcome, sidecar outcome, and capped failure summaries.
- [x] Given an index update completes with recoverable loader failures, when stats are requested, then the status is `partial` and failure summaries do not expose absolute paths.
- [x] Given an index update throws, when stats are requested after the failure, then the latest update status is `failed`.

**Linked Tests:** TS-OBS-237
**Dependencies:** FR-SEARCH-192

## Search

### FR-SUPERSEDED-232: Superseded Memory Review
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall provide a read-only `kb superseded` command that scans markdown notes in a selected knowledge base and reports notes that are candidates for manual supersession or contradiction review.

**Acceptance Criteria:**
- [x] Given notes with lifecycle frontmatter such as `contradicted_by`, deprecated-like `status` or `review_status`, stale `last_verified_at`, or low active `confidence`, when `kb superseded --kb=<name>` runs, then the report includes reason codes and relevant frontmatter for each candidate.
- [x] Given a semantically similar newer note from the same knowledge base, when it is newer, higher-confidence, or active while the candidate is older or lower-confidence, then the report includes `newer_near_neighbor` evidence with the evidence path and score.
- [x] Given clean notes, when `--include-clean` is omitted, then the report excludes them; when `--include-clean` is present, then the report includes them without mutation.
- [x] Given `--format=json`, when candidates are found, then the output is machine-readable and includes totals, candidates, reason codes, evidence, and suggested manual actions.

**Linked Tests:** TS-SUPERSEDED-232
**Dependencies:** RFC005, FR-SEARCH-192

### FR-SEARCH-192: Scoped Search Staleness
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall report staleness for the selected knowledge base when `kb search --kb=<name>` scopes a query.

**Acceptance Criteria:**
- [x] Given a scoped search, when files in the selected knowledge base are stale, then the stale counts reflect that selected knowledge base.
- [x] Given an unscoped search, when files across knowledge bases are stale, then the stale counts reflect global drift.
- [x] Given JSON output for a scoped search, when scoped and global stale counts differ, then the payload distinguishes scoped fields from global fields.

**Linked Tests:** TS-SEARCH-192
**Dependencies:** RFC005

## Stats

### FR-STATS-230: Local Stats CLI
**Status:** Implemented
**Priority:** Medium

**Requirement:** The system shall expose a read-only `kb stats` CLI command that reports the active index statistics available through the MCP `kb_stats` tool.

**Acceptance Criteria:**
- [x] Given an active model index, when a user runs `kb stats --format=json`, then the CLI emits the shared `computeKbStats` payload without refreshing the index.
- [x] Given `kb stats --kb=<name>`, when the knowledge base exists, then the CLI reports only that knowledge base.
- [x] Given markdown output, when stats are available, then the CLI prints a compact per-KB table plus embedding, index path, version, and uptime metadata.
- [x] Given an unknown flag or invalid format, when the user runs `kb stats`, then the CLI exits with code 2.

**Linked Tests:** TS-STATS-230
**Dependencies:** kb_stats MCP tool, multi-model active index resolution
