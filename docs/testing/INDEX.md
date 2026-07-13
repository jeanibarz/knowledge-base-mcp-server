# Testing

- [Retrieval eval command](retrieval-eval.md)
- [Retrieval eval methodology](retrieval-eval-methodology.md)
- [Fake LLM fixture](fake-llm.md)
- [Concurrency stress suite](../../tests/stress/README.md)
- [Fixtures](fixtures/README.md)
- RFC test surfaces:
  [RFC 017 contextual retrieval](../rfcs/017-contextual-retrieval.md),
  [RFC 018 relevance gating](../rfcs/018-context-relevance-gating.md)
  ([M1 canary report](../rfcs/018-m1-canary-report.md)),
  [RFC 019 cross-encoder reranker](../rfcs/019-cross-encoder-reranker.md)
  ([M0b reranker report](../rfcs/019-m0b-reranker-report.md))

## Jest Projects

`npm test` is the contributor and CI Jest gate. It runs `npm run build`, then:

- `npm run test:parallel` runs the Jest `parallel` project with `--maxWorkers=4`.
- `npm run test:serial` runs the Jest `serial` project with `--runInBand`.

Both scripts set `LOG_FILE=` for the Jest process. This keeps canonical-log assertions deterministic when a local agent shell exports a personal `LOG_FILE`; otherwise canonical events are appended to that file instead of being visible to tests that intentionally spy on stderr.

The serial project is the explicit escape hatch for suites with shared process, server, native-module, lock, watcher, or opt-in stress behavior:

- `src/FaissIndexManager.test.ts` uses native FAISS bindings, model-directory state, provider env mutation, and process signal listeners.
- `src/KnowledgeBaseServer.test.ts` exercises server lifecycle, canonical logging modes, mutation rollback, and trigger watchers.
- `src/cli-doctor.test.ts` performs filesystem permission probes and was observed to exceed Jest's default per-test timeout under the capped parallel CI runner on Node 24.
- `src/transport/http.test.ts` and `src/transport/sse.test.ts` bind real local HTTP/SSE servers and long-lived connections.
- `src/recursive-fs-watch.test.ts` and `src/triggerWatcher.test.ts` exercise filesystem watchers and timers.
- `src/reindex-runner.test.ts` covers reindex sentinels, process ids, and contextual-retrieval env.
- `src/write-lock.test.ts`, `src/docstore-cas.test.ts`, and `src/docstore-cas.integration.test.ts` exercise lock files and shared docstore CAS behavior.
- `tests/stress/**/*.test.ts` remains in the serial project because stress scenarios are process- and resource-sensitive even when skipped by default.
- `src/e2e/**/*.test.ts` joins the serial project only when `KB_RUN_E2E=1`.

New tests should stay in the parallel project unless they require one of those shared resources. Add a test to the serial project by listing its `<rootDir>/...` path once in `serialTestPathPatterns` in `jest.config.js` and documenting the reason in this section. Use a path without a trailing slash for one exact test file; use a directory path with a trailing slash (for example, `<rootDir>/tests/stress/`) for a recursive test directory. The parallel project's ignore patterns and the serial project's `testMatch` are derived from that single list, so there is no second list to keep in sync.

## Test Corpus Builder

Use `createTestCorpus` from `src/test-support/corpus.ts` for tests that need a temporary knowledge-base root with Markdown files. Pass a relative-path-to-content map and call `cleanup()` in `finally`:

```ts
const corpus = await createTestCorpus({
  files: {
    'ops/note.md': '# Note\n',
  },
});
try {
  // Use corpus.rootDir or corpus.pathFor('ops/note.md').
} finally {
  await corpus.cleanup();
}
```

Keep this helper limited to temp directory scaffolding, file writes, path lookup, and cleanup. Test-specific fakes for embeddings, indexes, process env, or CLI wiring should remain local to the tests that need them.

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

## Security

### TS-POLICY-854: Per-KB mutation policy enforcement
**Requirement:** NFR-POLICY-854

**Test Cases:**
- `createFileAtomically` shall enforce the target KB policy before creating parent directories or the new note.
- `rewriteFileAtomically` and `appendFileAtomically` shall require KB context and reject denied mutations without changing the target.
- `promoteApply` shall reject apply-mode rewrites in a policy-denied KB while leaving the note unchanged.
- `runImportUrl` and `createAskTranscriptNote` shall reject new notes in a policy-denied KB.

## Observability

### TS-OBS-831: Chat-completion telemetry
**Requirement:** FR-OBS-831

**Test Cases:**
- `LlmCallMetrics` shall count successes and errors by the bounded `ask`, `gate`, and `preface` operation labels and retain latency histograms.
- `callChatCompletion` shall parse prompt/completion usage when present and record one logical call across internal retries.
- `computeKbStats` and `kb doctor` shall expose the counters and token totals without turning query text or model strings into labels.
- The OpenMetrics formatter shall emit `kb_llm_calls_total`, `kb_llm_call_errors_total`, `kb_llm_tokens_total`, and `kb_llm_call_latency_ms` with bounded labels.

### TS-OBS-859: LLM attribution and workflow outcomes
**Requirement:** FR-OBS-859

**Test Cases:**
- `LlmCallMetrics` shall normalize provider/model values into bounded attribution rows and keep logical calls separate from provider attempts and retries.
- `callChatCompletion` shall record one logical call with the actual attempt and retry totals, including transient response-validation retries.
- Ask, relevance-gate, and contextual-preface boundaries shall record cache outcomes and answer impact, while an answer-cache hit shall avoid a provider call.
- Query and answer caches shall expose bounded hit/miss/not-applicable outcomes in their stats snapshots.
- `kb_stats`, `kb stats`, and `kb doctor` shall render attempts, retries, cache outcomes, answer impact, and bounded provider/model attribution.
- The OpenMetrics formatter shall emit the corresponding bounded operation, attribution, cache, impact, and cache-disk metric families without raw provider/model labels.
- The retrieval audit shall document that no distinct `retrieval_summary` path exists and is not applicable.

### TS-OBS-835: Relevance-gate endpoint readiness
**Requirement:** FR-OBS-835

**Test Cases:**
- `buildDoctorReport` and `buildEndpointReadinessReport` shall probe and report a healthy `gate_llm_endpoint` when the gate is enabled with an explicit gate endpoint.
- `buildDoctorReport` shall surface an unhealthy gate endpoint as a warning check while preserving the endpoint row's error status.
- `buildEndpointReadinessReport` shall report an unhealthy `gate_llm_endpoint` without changing the ask-endpoint result when the gate probe fails.
- `buildEndpointReadinessReport` shall skip the gate entry when the gate is disabled or its explicit endpoint is unset.

### TS-OBS-470: Config Schema Validation
**Requirement:** FR-OBS-470

**Test Cases:**
- `validateConfigEnv` shall emit `ok` findings for valid known env vars and summarize report counts.
- `validateConfigEnv` shall emit `error` findings for invalid booleans, enums, numbers, ranges, and URLs.
- `validateConfigEnv` shall emit static dependency findings for gated features missing their companion endpoint/token settings.
- `validateConfigEnv` and `kb doctor` shall reject `KB_CHUNK_OVERLAP >= KB_CHUNK_SIZE` with a finding that names both variables and the strict-less-than constraint.
- `parseDotEnvText` shall parse comments, `export`, quoted values, escapes, and inline comments for `kb config validate --file`.
- `kb config validate` shall expose JSON and markdown reports and map errors to exit code 1.

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
- `formatKbStatsOpenMetrics` shall emit the bounded index-update timestamp, one-hot status, failure-count snapshot, and duration families for success, partial, failed, and never-run summaries.
- `buildDoctorReport` shall grade partial, failed, non-zero-failure, warning, and skipped-file summaries as non-OK and keep fresh-index staleness non-OK; it shall retain an OK `index_update` check for clean and never-run summaries.
- A fresh-process doctor report shall load a persisted partial summary and grade its `index_update` and `staleness` checks as non-OK.

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

### TS-SEARCH-853: Hybrid Metadata Filter Correctness
**Requirement:** FR-SEARCH-853

**Test Cases:**
- Hybrid retrieval shall apply `extensions`, `path_glob`, `tags`, `since`, and `until` to lexical candidates before RRF fusion with the same AND semantics as dense retrieval.
- Filtered lexical retrieval shall refresh current source metadata, use bounded overfetch, preserve lexical scores without applying the dense similarity threshold, and clip accepted hits to the requested fetch size.
- The `retrieve_knowledge` hybrid handler shall exclude a lexical-only hit that violates the requested metadata filter.

### TS-CLI-383: Machine-Readable Help Manifest
**Requirement:** FR-CLI-383

**Test Cases:**
- `kb help --format=json` shall emit parseable JSON with schema version `kb.help.v1`, top-level usage, environment variables, exit codes, and every registered command.
- `kb help <command> --format=json` shall emit parseable JSON for the selected command with name, summary, usage, options, and stability metadata.
- `kb help <command> --format=json` shall preserve wrapped usage blocks without parsing example continuations as option definitions.
- `kb help --format=<unsupported>` and unknown `kb help` flags shall exit 2 with stderr diagnostics and empty stdout.
- `kb help <command> --format=json` shall preserve the existing unknown-command stderr error and exit code when the command is not registered.
- `kb help` without `--format=json` shall preserve the existing human-readable help output.

### TS-CLI-857: Knowledge-Base Document Listing
**Requirement:** FR-CLI-857

**Test Cases:**
- `parseLsArgs` shall parse KB, subtree prefix, long metadata, and Markdown/JSON format options while rejecting invalid values and traversal.
- The shared document inventory shall apply ingest filters, quarantine entries, deterministic ordering, strict subtree boundaries, and safe KB-root containment.
- `collectLsReport` and `formatLsReport` shall render KB-relative paths, long frontmatter/mtime metadata, and the stable `kb.ls.v1` JSON shape.
- The CLI smoke matrix shall exercise all-KB and prefix-scoped `kb ls` subprocess output plus unknown-KB and invalid-argument exit paths.

### TS-CLI-833: Safe Note Tag Mutation
**Requirement:** FR-CLI-833

**Test Cases:**
- `parseTagArgs` shall parse positional note selectors, repeated add/remove flags, formats, and explicit confirmation while rejecting incomplete or unknown arguments.
- `applyTagUpdates` shall apply stable add/remove set semantics, preserve the note body, create a tags array when needed, and reject malformed frontmatter.
- The strict frontmatter helpers shall reject missing fences and non-mapping YAML and shall validate the generated body boundary.
- `tagNote` shall leave dry-runs, malformed notes, denied policies, traversal selectors, and hidden/non-Markdown targets unchanged.
- `tagNote` shall atomically apply a mutation and `kb tags` shall report the resulting tag set.
- The CLI smoke matrix shall verify the built command's JSON dry-run output and argument-error path without an embedding backend.

### TS-CLI-832: Unknown Knowledge-Base Suggestions
**Requirement:** FR-CLI-832

**Test Cases:**
- `rankSuggestions` and `closestSuggestion` shall use the shared Levenshtein ranking with deterministic tie-breaking and support the documented typo example.
- `resolveKnowledgeBaseDir` shall include a bounded, closeness-ordered available-KB list and nearest-name suggestion in `KB_NOT_FOUND` errors.
- Lexical `kb search --kb=<unknown>` shall preserve its error prefix and include the same available-KB list and suggestion.

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

### TS-SEARCH-834: Query-time index corruption degradation
**Requirement:** NFR-SEARCH-834

**Test Cases:**
- `kb search` shall classify a corrupt active FAISS artifact as an indexing failure rather than throw an uncaught error.
- The lexical retrieval leg shall classify torn per-KB lexical JSON as a per-KB failure and preserve partial-result semantics.
- Dense retrieval shall return matching documents via post-filter overfetch when the metadata sidecar is missing or short.

## Relevance Gate (RFC 018)

### TS-LLM-465: Fake LLM Fixture
**Requirement:** FR-LLM-465

**Test Cases:**
- `KB_LLM_FAKE=on` shall route `callChatCompletion` to the in-process fake LLM without invoking `fetch`.
- The fake LLM shall produce deterministic Stage B relevance judge JSON that preserves the existing judge parser contract.
- The fake LLM shall generate deterministic contextual prefaces without `KB_LLM_ENDPOINT`.
- `kb ask` shall resolve a fake LLM target and answer from packed snippets without a live server.
- `npm run dev:mockllm` shall serve OpenAI-compatible `/v1/chat/completions` and `/health` endpoints.

### TS-POLICY-494: Frontmatter Sensitivity Policy
**Requirement:** FR-POLICY-494

**Test Cases:**
- Ingest shall lift typed `kb_policy.no_llm_context`, `kb_policy.resource_read`, and `kb_policy.sensitivity` frontmatter into chunk metadata.
- `kb ask` and MCP `ask_knowledge` shall exclude chunks marked `frontmatter.kb_policy.no_llm_context: true` from LLM prompt context and report `context_packing.policy_filtered_chunks`.
- `kb ask` and MCP `ask_knowledge` shall hydrate current source-file `kb_policy` frontmatter before LLM prompt packing so stale indexes do not leak newly marked sensitive notes.
- `resources/read` shall reject Markdown resources with `kb_policy.resource_read: deny`.
- `resources/read` shall reject `kb_policy.resource_read: local_only` when the MCP transport is HTTP/SSE and allow it for local stdio reads.

### TS-SEC-829: `no_llm_context` LLM Egress Enforcement
**Requirement:** NFR-SEC-829

**Test Cases:**
- Contextual-preface ingest shall skip LLM calls and prefaces for documents marked `kb_policy.no_llm_context: true`.
- The relevance-gate judge prompt shall exclude protected candidate content while retaining non-sensitive candidates.
- The relevance gate shall preserve all-protected candidates as unjudged results and shall not replay a pre-policy verdict after a candidate becomes protected.
- The relevance gate shall hydrate current source-file policy before judging candidates whose index metadata is stale.
- The relevance gate shall fail closed, preserving but not judging candidates whose source policy cannot be read or parsed.

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

### TS-STATS-469: OpenMetrics Export
**Requirement:** FR-STATS-469

**Test Cases:**
- The OpenMetrics formatter shall serialize KB, provider-call, LLM-call, query-cache, relevance-gate, and remote-transport stats with bounded labels and a terminal `# EOF`.
- `kb serve` shall mount `GET /metrics` only when `KB_METRICS_EXPORT=on`.
- HTTP and SSE transports shall mount `GET /metrics` behind the existing bearer-token auth gate when `KB_METRICS_EXPORT=on`.

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
