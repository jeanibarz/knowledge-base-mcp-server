# Requirements

- [Retrieval eval command](retrieval-eval.md)

## Indexing

### NFR-INDEX-358: Default Text-First Ingest Filter
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall exclude PDF files from the default ingest allowlist while preserving explicit operator opt-in for PDF extraction.
**Rationale:** PDF extraction is heavyweight and many knowledge bases store markdown notes beside source PDFs; default refreshes should avoid duplicate, expensive PDF ingestion.

**Acceptance Criteria:**
- [x] Given markdown and PDF files in the same knowledge base, when default ingest filtering runs, then markdown files are accepted and PDF files are excluded.
- [x] Given `INGEST_EXTRA_EXTENSIONS` includes `.pdf`, when ingest filtering runs, then PDF files are accepted unless an exclusion glob also matches them.
- [x] Given `INGEST_EXCLUDE_PATHS` matches an opt-in PDF subtree, when ingest filtering runs, then matching PDF files remain excluded.
- [x] Given an existing index was written when PDFs were ingestable, when refresh runs with the new default filter, then the system rebuilds from currently ingestable files and purges stale PDF sidecars.

**Linked Tests:** TS-INDEX-358
**Dependencies:** RFC011

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

### NFR-INDEX-281: Duplicate Chunk Embedding Compaction
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall embed each unique normalized changed-file chunk text at most once per `updateIndex` operation while preserving one FAISS/docstore entry for every source chunk.
**Rationale:** Knowledge bases often contain repeated boilerplate, mirrored notes, or duplicated generated sections. Exact normalized-text compaction reduces provider embedding work without changing citation or retrieval metadata.

**Acceptance Criteria:**
- [x] Given changed chunks with identical normalized text across files or knowledge bases, when `updateIndex` embeds them in one operation, then the embedding provider receives that normalized text once.
- [x] Given duplicate chunk text is compacted for provider calls, then the FAISS insertion path still receives every source chunk and its source-specific metadata.
- [x] Given a query embedding is requested, then document-indexing compaction shall not alter query embedding behavior.

**Linked Tests:** TS-INDEX-281
**Dependencies:** NFR-INDEX-236

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

### FR-OBS-315: Persisted Last Index Update Summary
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall persist the latest `updateIndex` run summary under the active model directory and use that persisted summary for fresh-process stats and doctor reports when no in-process update has run.
**Rationale:** Long refreshes can finish in a different CLI process from later diagnostics; persisting the compact sanitized summary preserves post-mortem evidence without requiring the original terminal output.

**Acceptance Criteria:**
- [x] Given an index update completes successfully, when the update finishes, then the active model directory contains the latest sanitized update summary.
- [x] Given an index update fails or completes partially, when the update attempt finishes, then the active model directory contains the failed or partial summary with capped failure details.
- [x] Given `kb stats` or `kb doctor` runs in a fresh process and the in-memory summary is `never_run`, when a persisted summary exists for the active model, then the report uses the persisted summary.
- [x] Given the persisted summary is missing or malformed, when stats or doctor output is requested, then the report falls back to the in-memory `never_run` summary.

**Linked Tests:** TS-OBS-315
**Dependencies:** FR-OBS-237

### FR-OBS-316: Refresh Progress Heartbeats
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall emit phase-aware `kb search --refresh` progress heartbeats to stderr during dense index refresh work without writing progress text to JSON stdout.
**Rationale:** Long refreshes spend most of their wall time embedding and saving after file discovery has already logged changes; operators need bounded-batch progress without breaking machine-readable search output.

**Acceptance Criteria:**
- [x] Given changed-file chunks exceeding the configured indexing batch size, when `updateIndex` embeds them, then progress events identify each bounded embedding batch.
- [x] Given `kb search --refresh --format=json`, when refresh progress is emitted, then progress lines are written to stderr and the JSON success payload remains parseable on stdout.
- [x] Given `kb search --refresh --format=json --timing`, when refresh progress is emitted, then the timing payload includes refresh embedding batch counters and phase elapsed counters.

**Linked Tests:** TS-OBS-316
**Dependencies:** NFR-INDEX-236

## Search

### FR-CLI-383: Machine-Readable Help Manifest
**Status:** Implemented
**Priority:** Medium

**Requirement:** The system shall expose command and option metadata through `kb help --format=json` without requiring callers to parse prose help output.
**Rationale:** Contributor tooling, completions, and agent workflows need a stable command manifest that stays aligned with the CLI registry and per-command help text.

**Acceptance Criteria:**
- [x] Given `kb help --format=json`, when the command runs, then stdout is valid JSON with a stable schema version, top-level usage, environment variables, exit codes, and every registered command.
- [x] Given `kb help <command> --format=json`, when the command exists, then stdout is valid JSON for that command with its name, summary, usage lines, option metadata, and stability tag.
- [x] Given `kb help <command> --format=json`, when the command does not exist, then the CLI preserves the existing unknown-command stderr error and exit code.
- [x] Given `kb help` without `--format=json`, when the command runs, then existing markdown/plain help output remains unchanged.

**Linked Tests:** TS-CLI-383
**Dependencies:** RFC012

### FR-ASK-382: Cited Ask Transcript Records
**Status:** Implemented
**Priority:** Medium

**Requirement:** The system shall let `kb ask` persist a cited answer transcript as a new knowledge-base note only when the caller explicitly requests transcript saving and confirms the write.
**Rationale:** Generated answers are useful durable knowledge only when the saved record includes the original question, answer, citations, source chunk identifiers, LLM provenance, retrieval metadata, and write-path safeguards.

**Acceptance Criteria:**
- [x] Given `kb ask --save-transcript --kb=<name> --yes`, when retrieval and LLM answering succeed, then the system writes a new markdown note in the target knowledge base containing the question, answer, citations, source chunk ids, LLM endpoint/profile/model, retrieval model, and timing metadata when available.
- [x] Given `--save-transcript` without `--yes`, when argument validation runs, then the system refuses to write and exits with an input error.
- [x] Given `--save-transcript` without `--kb=<name>`, when argument validation runs, then the system refuses the call because no transcript target is defined.
- [x] Given a transcript title whose slug already exists, when the write path runs, then the system refuses to overwrite the existing note.

**Linked Tests:** TS-ASK-382
**Dependencies:** FR-STATS-230

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
