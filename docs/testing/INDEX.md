# Testing

- [Retrieval eval command](retrieval-eval.md)
- [Retrieval eval methodology](retrieval-eval-methodology.md)
- [Fake LLM fixture](fake-llm.md)
- [Fixtures](fixtures/README.md)
- RFC test surfaces:
  [RFC 017 contextual retrieval](../rfcs/017-contextual-retrieval.md),
  [RFC 018 relevance gating](../rfcs/018-context-relevance-gating.md)
  ([M1 canary report](../rfcs/018-m1-canary-report.md)),
  [RFC 019 cross-encoder reranker](../rfcs/019-cross-encoder-reranker.md)
  ([M0b reranker report](../rfcs/019-m0b-reranker-report.md))

## Indexing

### TS-INDEX-358: Default Text-First Ingest Filter
**Requirement:** NFR-INDEX-358

**Test Cases:**
- `filterIngestablePaths` shall exclude `.pdf` files by default while accepting markdown notes.
- `filterIngestablePaths` shall accept `.pdf` files when `.pdf` is supplied through `extraExtensions`.
- `filterIngestablePaths` shall let `excludePaths` suppress PDF files even after PDF extension opt-in.
- `FaissIndexManager.updateIndex` shall let `INGEST_EXCLUDE_PATHS` suppress PDFs after `.pdf` extension opt-in.
- `FaissIndexManager.updateIndex` shall rebuild from current ingestable files when the freshness manifest records an older base allowlist that admitted PDFs.
- `RecursiveFsWatcher` shall honor ingest exclusion globs for otherwise ingestable markdown paths.

### TS-INDEX-236: Batched Changed-File Embeddings
**Requirement:** NFR-INDEX-236

**Test Cases:**
- `resolveIndexingBatchSize` shall use provider defaults and validate `INDEXING_BATCH_SIZE`.
- `FaissIndexManager.updateIndex` shall batch multiple changed files into a single seed call when they fit the configured batch size.
- `FaissIndexManager.updateIndex` shall split changed-file documents into bounded append batches when the configured batch size is exceeded.
- `FaissIndexManager.updateIndex` shall keep the one-save-at-end invariant and write sidecar hashes only after a successful save.
- `FaissIndexManager` shall resolve unset batch defaults from an explicitly configured manager provider.

### TS-INDEX-281: Duplicate Chunk Embedding Compaction
**Requirement:** NFR-INDEX-281

**Test Cases:**
- `normalizeChunkTextForEmbedding` shall collapse insignificant Unicode and whitespace differences before indexing dedupe.
- `FaissIndexManager.updateIndex` shall call the embedding provider with unique normalized changed-file chunk text while preserving every duplicate source metadata entry in the FAISS insertion path.

### TS-INDEX-468: SQ8 FAISS Index Option
**Requirement:** FR-INDEX-468

**Test Cases:**
- `KB_INDEX_TYPE` shall default to `flat`, accept `sq8`, and reject unknown values.
- `FaissStoreAdapter.fromDocuments` shall create and train an SQ8 FAISS index before adding vectors.
- `saveFaissStoreAtomic` shall persist the active index type in `integrity.json`.
- `kb stats` shall expose the active model index type in JSON and markdown output.

## Observability

### TS-OBS-467: Deep Index Integrity Verification
**Requirement:** FR-OBS-467

**Test Cases:**
- `saveFaissStoreAtomic` shall persist a `kb.index-integrity.v1` manifest containing SHA-256 hashes for `faiss.index` and `docstore.json`.
- `verifyIntegrity` shall return clean status for matching FAISS/docstore hashes, matching source sidecars, valid chunk manifests, and matching lexical/dense chunk counts.
- `verifyIntegrity` shall classify FAISS or docstore manifest hash mismatches and malformed docstore JSON as corruption.
- `verifyIntegrity` shall classify missing/stale content-hash sidecars, stale chunk manifests, orphan sidecars, retention drift, and stale sentinels as drift.
- `kb verify --integrity` and `kb doctor --integrity` shall expose the integrity report in markdown and JSON with the documented exit-code severity mapping.

### TS-OBS-237: Last Index Update Summary
**Requirement:** FR-OBS-237

**Test Cases:**
- `FaissIndexManager` shall initialize the latest update summary as `never_run`.
- `FaissIndexManager.updateIndex` shall record success counters for changed and unchanged files.
- `FaissIndexManager.updateIndex` shall retain a failed summary when save persistence throws.
- `computeKbStats` shall include the manager's latest update summary in the payload.
- `buildDoctorReport` and `formatDoctorMarkdown` shall include the latest update summary.

### TS-OBS-315: Persisted Last Index Update Summary
**Requirement:** FR-OBS-315

**Test Cases:**
- `FaissIndexManager.updateIndex` shall atomically persist the completed summary under the active model directory.
- `FaissIndexManager.updateIndex` shall persist failed and partial summaries with capped sanitized failure details.
- `computeKbStats` shall use the persisted summary when the manager summary is `never_run`.
- `computeKbStats` shall ignore missing or malformed persisted summaries and keep the manager summary.
- `buildDoctorReport` shall use the persisted summary for the active model when no explicit in-process summary is supplied.

### TS-OBS-316: Refresh Progress Heartbeats
**Requirement:** FR-OBS-316

**Test Cases:**
- `FaissIndexManager.updateIndex` shall emit one `embed` progress event for each bounded embedding batch.
- `formatRefreshProgressLine` shall format embedding batch progress as concise operator-facing stderr text.
- `createRefreshProgressReporter` shall write progress through the stderr writer and shall not write to stdout.
- `recordRefreshProgressTiming` shall copy refresh batch counters and completed phase elapsed times into the flat timing payload.

## Search

### TS-SEARCH-374: Cross-Encoder Reranker
**Requirement:** FR-SEARCH-374

**Test Cases:**
- `resolveRerankerConfig` shall parse `KB_RERANK`, `KB_RERANK_MODEL`, and `KB_RERANK_TOP_N`, with per-call overrides taking precedence.
- `rerankFusedResults` shall sort the configured top-N candidate block by descending reranker score and preserve the unscored tail after that block.
- `rerankFusedResults` shall cache repeated query/candidate scores in memory.
- `rerankFusedResults` shall degrade to the original fused order when the provider throws or returns a wrong-length score array.
- `formatRetrievalAsJson` shall include `rerank_score` when a retrieval result carries a reranker score.
- `kb eval` shall compare `KB_RERANK=off` and `KB_RERANK=on` ranked metrics before any default-on rollout.

### TS-CLI-383: Machine-Readable Help Manifest
**Requirement:** FR-CLI-383

**Test Cases:**
- `kb help --format=json` shall emit parseable JSON with schema version `kb.help.v1`, top-level usage, environment variables, exit codes, and every registered command.
- `kb help <command> --format=json` shall emit parseable JSON for the selected command with name, summary, usage, options, and stability metadata.
- `kb help <command> --format=json` shall preserve wrapped usage blocks without parsing example continuations as option definitions.
- `kb help --format=<unsupported>` and unknown `kb help` flags shall exit 2 with stderr diagnostics and empty stdout.
- `kb help <command> --format=json` shall preserve the existing unknown-command stderr error and exit code when the command is not registered.
- `kb help` without `--format=json` shall preserve the existing human-readable help output.

### TS-ASK-382: Cited Ask Transcript Records
**Requirement:** FR-ASK-382

**Test Cases:**
- `parseAskArgs` shall parse `--save-transcript`, `--title=<title>`, and `--yes`.
- `parseAskArgs` shall reject transcript saves without `--yes` or without a target `--kb=<name>`.
- `buildAskTranscriptMarkdown` shall include the question, answer, citation paths, source chunk ids, LLM provenance, retrieval metadata, and timing metadata when present.
- `createAskTranscriptNote` shall create a new slugged markdown note and shall refuse to overwrite an existing transcript note.

### TS-SUPERSEDED-232: Superseded Memory Review
**Requirement:** FR-SUPERSEDED-232

**Test Cases:**
- `parseSupersededArgs` shall validate `--kb=<name>`, `--format=md|json`, `--k=<int>`, and `--include-clean`.
- `supersededCheck` shall flag explicit contradiction, deprecated lifecycle status, stale verification dates, and low-confidence active notes.
- `supersededCheck` shall add `newer_near_neighbor` evidence only for same-KB semantic hits that are not the candidate file and are newer, higher-confidence, or active.
- `formatSupersededJson` and `formatSupersededMarkdown` shall include candidate paths, reasons, evidence, and totals without writing to the knowledge base.

### TS-SEARCH-192: Scoped Search Staleness
**Requirement:** FR-SEARCH-192

**Test Cases:**
- `computeStaleness` shall count modified and new files in the selected KB separately from other KBs.
- `computeStaleness` shall preserve global modified and new file counts for unscoped searches.
- `formatFreshnessFooter` and JSON payload tests shall verify scoped fields remain distinct from global fields.

## Relevance Gate (RFC 018)

### TS-LLM-465: Fake LLM Fixture
**Requirement:** FR-LLM-465

**Test Cases:**
- `KB_LLM_FAKE=on` shall route `callChatCompletion` to the in-process fake LLM without invoking `fetch`.
- The fake LLM shall produce deterministic Stage B relevance judge JSON that preserves the existing judge parser contract.
- The fake LLM shall generate deterministic contextual prefaces without `KB_LLM_ENDPOINT`.
- `kb ask` shall resolve a fake LLM target and answer from packed snippets without a live server.
- `npm run dev:mockllm` shall serve OpenAI-compatible `/v1/chat/completions` and `/health` endpoints.

### TS-GATE-EVAL-369: M0 Gate Validation Harness
**Requirement:** FR-GATE-EVAL-369

**Test Cases:**
- `kb eval-gate` shall parse the gate-eval fixture and emit a stable `kb.eval-gate.v1`-shaped JSON or markdown report.
- `kb eval-gate --dry-run` and `kb eval-gate` without a reachable endpoint shall fall back to the offline causal model and still produce a report.
- `kb eval-gate --m1` shall require a reachable endpoint and exit non-zero when no endpoint is configured.
- The aggregated summary shall include the three pre-registered numbers: `empty_verdict_fire_rate`, `per_chunk_drop_no_good_answer_delta`, `judge_false_empty_rate`.

### TS-GATE-379: Stage A Statistical Floor + Stage B LLM Judge
**Requirement:** FR-GATE-379

**Test Cases:**
- `applyRelevanceGate` shall short-circuit when `KB_RELEVANCE_GATE=off` and emit `gate.skipped` canonical events when on.
- The Stage A floor (`KB_GATE_SCORE_FLOOR`) shall drop candidates strictly below the configured distance.
- The Stage B LLM judge shall be invoked only when `KB_GATE_LLM_ENDPOINT` (or `KB_LLM_ENDPOINT` fallback) resolves, task context meets `KB_GATE_MIN_TASK_TOKENS`, and Stage A retained ≥ 1 candidate.
- Judge failures (timeout, non-JSON, bad model id) shall degrade to retrieval rather than failing the search.
- `KB_GATE_EMPTY_VERDICT=on` shall let the gate return an empty set; the default `off` shall fall back to the pre-gate top-k.

### TS-GATE-422: Untrusted Task-Context Policy
**Requirement:** FR-GATE-422

**Test Cases:**
- `KB_GATE_TASK_CONTEXT_MODE=warn` (default) shall log on stderr but accept long or injection-bearing argv task context.
- `KB_GATE_TASK_CONTEXT_MODE=strict` shall refuse injection-signal-bearing argv task context with exit code 2.
- `KB_GATE_TASK_CONTEXT_MODE=off` shall apply neither check.
- `--task-context-file=<path>` shall always bypass the argv length check.

## Research

### TS-RESEARCH-451: Evidence Plan and Collect
**Requirement:** FR-RESEARCH-451

**Test Cases:**
- `kb research plan` shall emit a `kb.research.v1` plan envelope with a vetted set of query candidates and `--format=json` validation.
- `kb research collect` shall execute the plan and write `run.json`, `plan.json`, `ledger.json`, `evidence_packet.md`, and `events.jsonl`.
- The collector shall honor `--k=<int>` as the per-query/shelf retrieval cap, keep `ledger.json` lossless, and group duplicate passages in `evidence_packet.md` with query provenance.

### TS-RESEARCH-452: Planner Selection Tightening
**Requirement:** FR-RESEARCH-452

**Test Cases:**
- `kb research plan` shall reject queries containing prompt-injection signals and shall not echo them in the plan envelope.
- The planner shall skip non-actionable / generic queries that fail the minimum-task-token threshold.

## Feedback

### TS-FEEDBACK-436: Relevance Feedback Ledger
**Requirement:** FR-FEEDBACK-436

**Test Cases:**
- `kb feedback add` shall append a `relevance-feedback.v1` entry to `<kb>/.index/relevance-feedback.jsonl` with stable id, timestamp, query, source, verdict, and graded relevance.
- `kb feedback list` shall return entries sorted by `created_at` descending and honor `--query` and `--limit`.
- `kb feedback promote` shall produce a YAML preview without `--fixture --yes` and shall append a `kb eval` case to the target fixture when both are supplied.
- The ledger shall store `task_context_sha256` (never the raw text) when `--task-context` is supplied.

## Logging and Observability

### TS-LOGS-397: Canonical Log Reader
**Requirement:** FR-LOGS-397

**Test Cases:**
- `kb logs recent --format=json` shall return the latest `kb-canonical.v1` events from the discovered log file.
- `kb logs show --request-id=<id>` and `--query-sha=<hash>` shall return matching events with stable counts of scanned, ignored, and malformed lines.
- The reader shall ignore non-canonical text lines and shall not write to stdout when no events match (returns `result_count: 0`).
- File-resolution order shall be `--file` → `LOG_FILE` → existing local default paths.

### TS-STATS-419: Contextual Preface Stats
**Requirement:** FR-STATS-419

**Test Cases:**
- `computeKbStats` shall include `contextual_preface` cache hit/miss/failure counters when RFC 017 ingest is enabled.
- The block shall be omitted when the contextual-retrieval flag is off, preserving the prior payload shape.

### TS-STATS-442: Remote Transport Stats
**Requirement:** FR-STATS-442

**Test Cases:**
- `computeKbStats` shall include a `remote_transport` block with request, auth-failure, and backoff counters when the HTTP or SSE transport is active.
- The block shall be omitted under stdio transport.

## Reindex

### TS-REINDEX-407: Reindex Status Ledger
**Requirement:** FR-REINDEX-407

**Test Cases:**
- `kb reindex status --format=json` shall read the `.reindex.run.json` ledger and report current or most recent runs with `kb_scope`, `model`, timestamps, chunk counters, cache hit-rate, and any failure code.
- The reader shall report a clearly-typed "no runs" envelope when the ledger is missing rather than failing.

### TS-REINDEX-408: Cache-Aware Estimate
**Requirement:** FR-REINDEX-408

**Test Cases:**
- The contextual-reindex estimator shall subtract chunks already present in the preface cache from the total chunk count before producing the wall-clock estimate.

## Serve / Daemon

### TS-SERVE-410: kb serve status
**Requirement:** FR-SERVE-410

**Test Cases:**
- `kb serve status` shall query `GET /health` at `KB_DAEMON_URL` and never start or stop a daemon.
- Reachable daemons shall produce exit code 0 with PID, uptime, idle-timeout, and command-list fields when the `/health` payload supplies them.
- An unreachable daemon shall produce exit code 3 with a clear "no daemon at <url>" message.
- A daemon answering with an unusable `/health` payload shall produce exit code 1.
- Invalid `KB_DAEMON_URL` shall produce exit code 2.

## Stats

### TS-STATS-230: Local Stats CLI
**Requirement:** FR-STATS-230

**Test Cases:**
- `runStats` shall print the `computeKbStats` payload unchanged for `--format=json`.
- `runStats` shall pass `--kb=<name>` through as `knowledgeBaseName`.
- `runStats` shall load the active model read-only and shall not call `updateIndex`.
- `runStats` shall print markdown table output with per-KB rows and index metadata.
- `runStats` shall reject unknown flags with exit code 2.
- `runStats` shall emit structured JSON errors for missing knowledge bases when JSON output is requested.
