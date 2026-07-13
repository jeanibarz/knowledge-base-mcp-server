# Requirements

- [Retrieval eval command](retrieval-eval.md)
- [Reranker](reranker.md)
- Source RFCs:
  [RFC 017 contextual retrieval](../rfcs/017-contextual-retrieval.md),
  [RFC 018 relevance gating](../rfcs/018-context-relevance-gating.md),
  [RFC 019 cross-encoder reranker](../rfcs/019-cross-encoder-reranker.md)

## Indexing

### NFR-BENCH-712: KB CLI Evolution Harness
**Status:** Implemented
**Priority:** Medium

**Requirement:** The system shall provide an advisory evolution harness that compares `kb` CLI benchmark champion and challenger arms, applies pre-registered objective and budget gates, and emits deterministic promotion artifacts without mutating defaults or benchmark baselines.
**Rationale:** Performance and efficiency improvements need a repeatable champion/challenger loop that can explore configuration and implementation hypotheses while preserving retrieval quality and regression budgets.

**Acceptance Criteria:**
- [x] Given a plan with a champion report and candidate reports, when the evolution harness runs, then it writes `decision.json`, `report.md`, and copied arm reports under a run directory.
- [x] Given a candidate improves the configured objective metric and has no disallowed budget rows, then the decision promotes that candidate over the champion.
- [x] Given a candidate improves the objective metric but triggers a protected quality or performance budget failure, then the decision holds the champion.
- [x] Given a candidate improvement is below the pre-registered objective margin, then the decision holds the champion.
- [x] Given an arm supplies a command instead of a report path, then the harness can execute the command with arm-specific environment variables and consume the emitted benchmark JSON artifact.
- [x] Given durable evolution state, when a single iteration runs, then the system shall generate a plan, run the champion/challenger benchmark, update `state.json`, and append `history.md`.
- [x] Given no eligible candidate remains for the current champion, when the iteration wrapper runs, then the chain shall stop with a cap/no-work exit instead of rerunning stale arms.
- [x] Given an operator wants unattended convenience, when they use the Kookr playbook or `bin/run-chain.sh`, then the system shall provide the same one-iteration/self-continuation contract used by the sibling evolution repositories.

**Linked Tests:** TS-BENCH-712
**Dependencies:** NFR-INDEX-236, RFC020

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

### FR-OBS-831: Chat-completion telemetry
**Status:** Implemented
**Priority:** Medium

**Requirement:** The system shall record process-lifetime chat-completion call, error, latency, and provider-reported token metrics by the bounded `ask`, `gate`, and `preface` operations, and expose them through `kb_stats`, `kb stats`, `kb doctor`, and the OpenMetrics exporter.
**Rationale:** Chat generation is the largest and most variable LLM cost surface, but previously had no operator-visible latency, failure, or token-spend signal.

**Acceptance Criteria:**
- [x] Given a chat-completion success or failure, when the call finishes, then the corresponding operation counter, error counter, and latency histogram shall be updated, including calls that exhaust retries.
- [x] Given an OpenAI-compatible response with `usage.prompt_tokens` or `usage.completion_tokens`, when metrics are exported, then the reported token totals shall be emitted by operation and token type.
- [x] Given arbitrary query content, KB names, model strings, or request ids, when metrics are exported, then none shall become labels; operation labels remain limited to `ask`, `gate`, and `preface`.
- [x] Given `kb stats` or `kb doctor`, when chat calls have been observed, then the human-readable output shall show per-operation calls, errors, latency, and token totals.

**Linked Tests:** TS-OBS-831
**Dependencies:** FR-STATS-230, FR-STATS-469

### FR-OBS-859: LLM provider, retry, cache, and answer attribution
**Status:** Implemented
**Priority:** Medium

**Requirement:** The system shall extend process-lifetime chat-completion telemetry with bounded provider/coarse-model attribution, logical-call versus provider-attempt/retry accounting, workflow-boundary cache outcomes, and workflow-declared answer impact, and shall expose the additive telemetry through `kb_stats`, `kb stats`, `kb doctor`, and OpenMetrics without changing existing operation-only contracts.
**Rationale:** Operation-only counters show how often chat paths run but cannot distinguish provider/model mix, retry cost, cache effectiveness, or whether an LLM result was consumed by the answer workflow.

**Acceptance Criteria:**
- [x] Given a logical chat call, when telemetry is recorded, then its provider and normalized coarse model family are present in bounded attribution rows and raw provider model strings are absent from metric labels.
- [x] Given internal provider retries, when telemetry is recorded, then one logical call has multiple attempts and the corresponding retry count without inflating the logical call count.
- [x] Given an answer, gate, preface, or query-cache workflow boundary, when cache evaluation completes, then it records exactly one bounded `hit`, `miss`, or `not_applicable` outcome; an answer-cache hit does not create an LLM provider call.
- [x] Given a workflow consumes, discards, or cannot determine the effect of an LLM result, when it completes, then it records `used`, `not_used`, or `unknown` answer impact.
- [x] Given the current retrieval implementation, when the LLM paths are audited, then no distinct retrieval-summarization path is present and the documentation records `retrieval_summary` as not applicable for this issue.
- [x] Given `kb stats`, `kb doctor`, or OpenMetrics output, when attributed telemetry exists, then attempts, retries, cache outcomes, answer impact, provider, and coarse model are operator-visible with bounded labels.

**Linked Tests:** TS-OBS-859
**Dependencies:** FR-OBS-831, FR-STATS-230, FR-STATS-469

### FR-OBS-835: Relevance-gate endpoint readiness
**Status:** Implemented
**Priority:** Medium

**Requirement:** The system shall report the explicitly configured relevance-gate LLM endpoint in `kb doctor` and `kb doctor --endpoints` when the gate is enabled, and shall skip that entry when the gate is disabled or the endpoint is unset.
**Rationale:** Operators need the doctor preflight to detect an unavailable judge endpoint before gated retrieval silently degrades, without treating an intentionally disabled or unconfigured gate as a failure.

**Acceptance Criteria:**
- [x] Given `KB_RELEVANCE_GATE=on` and `KB_GATE_LLM_ENDPOINT` set, when `kb doctor` or endpoint readiness runs, then it shall probe and report a distinct `gate_llm_endpoint` entry.
- [x] Given a reachable gate endpoint, when endpoint readiness runs, then the gate entry shall be healthy.
- [x] Given an unreachable or unhealthy gate endpoint, when endpoint readiness runs, then the gate entry shall report an error.
- [x] Given the gate is disabled or `KB_GATE_LLM_ENDPOINT` is unset, when endpoint readiness runs, then the gate entry shall be skipped rather than failed.
- [x] Given any gate configuration, when endpoint readiness runs, then the existing ask-endpoint entry shall retain its behavior.

**Linked Tests:** TS-OBS-835
**Dependencies:** FR-GATE-379

### FR-OBS-470: Config Schema Validation
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall provide `kb config validate` to validate known environment variables from the current process environment or a supplied `.env` file against a declarative schema for type, range, enum membership, and static cross-variable dependencies.
**Rationale:** The KB server is configured primarily through environment variables. Operators need a preflight command that catches typos and inconsistent flag combinations before startup or CI scripts silently fall back to defaults.

**Acceptance Criteria:**
- [x] Given valid known environment variables, when `kb config validate --format=json` runs, then the system shall emit a `kb.config-validate.v1` report with per-variable `ok` findings and exit 0.
- [x] Given invalid type, enum, URL, or range values, when validation runs, then the system shall emit per-variable `error` findings and exit 1.
- [x] Given static dependencies such as HTTP/SSE transport without a usable auth token, relevance gating without any judge endpoint, or contextual retrieval without an LLM endpoint, when validation runs, then the system shall emit dependency findings without probing live endpoints.
- [x] Given `--file=<path>`, when validation runs, then the system shall parse that `.env` file instead of `process.env` and report the file path as the value source.
- [x] Given no `--format=json`, when validation runs, then the system shall emit a human-readable markdown table with the same verdicts.

**Linked Tests:** TS-OBS-470
**Dependencies:** FR-OBS-467, FR-CLI-383

### FR-OBS-467: Deep Index Integrity Verification
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall provide an opt-in `kb verify --integrity` audit that verifies persisted FAISS index versions, integrity manifests, docstore JSON, lexical chunk counts, per-file content-hash sidecars, chunk manifests, retained-version drift, and stale index sentinels without mutating the knowledge base or index.
**Rationale:** Recovery paths handle known interruption signatures, but operators also need a positive at-rest assertion that index bytes, manifests, sidecars, and source files still agree after crashes, backup restores, cloud-sync drift, or tampering.

**Acceptance Criteria:**
- [x] Given a saved versioned FAISS index, when integrity verification runs, then the system shall hash `faiss.index` and `docstore.json` and compare those hashes with the version's integrity manifest.
- [x] Given a malformed docstore, malformed manifest, missing index file, or manifest hash mismatch, when integrity verification runs, then the system shall emit a structured corruption finding and exit with code 2.
- [x] Given source files whose `.index` content-hash sidecars or chunk manifests are missing, stale, or orphaned, when integrity verification runs, then the system shall emit structured drift findings and exit with code 1 when no corruption exists.
- [x] Given a lexical index for a knowledge base, when integrity verification runs, then the lexical chunk count shall match the active dense docstore chunk count for that knowledge base.
- [x] Given `kb doctor --integrity` or `kb doctor --slow`, when the doctor report is built, then the slow integrity audit shall be included in the report and folded into doctor status.

**Linked Tests:** TS-OBS-467
**Dependencies:** RFC014, NFR-INDEX-358

### FR-OBS-237: Last Index Update Summary
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall expose the latest in-process `updateIndex` run summary through `kb_stats`, `kb doctor`, and the OpenMetrics exporter, and shall grade incomplete or failed index updates as unhealthy in doctor diagnostics.

**Acceptance Criteria:**
- [x] Given no update has run in the current process, when stats or doctor output is requested, then the latest update status is `never_run`.
- [x] Given an index update runs, when stats are requested, then the payload reports the run scope, model id, timestamps, duration, file counters, chunk counters, save outcome, sidecar outcome, and capped failure summaries.
- [x] Given an index update completes with recoverable loader failures, when stats are requested, then the status is `partial` and failure summaries do not expose absolute paths.
- [x] Given an index update throws, when stats are requested after the failure, then the latest update status is `failed`.
- [x] Given a latest update summary, when the OpenMetrics exporter is scraped, then it emits the completion timestamp, one-hot status, failure-count snapshot, and duration with bounded status labels.
- [x] Given a latest update summary with `partial` or `failed` status, a non-zero `failure_count`, `warning_count`, or `files_skipped`, when `kb doctor` runs, then the `index_update` check is non-OK and a freshly rewritten incomplete index does not make the `staleness` check green.

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

### FR-SEARCH-374: Cross-Encoder Reranker
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall optionally rerank first-stage retrieval candidates with a local cross-encoder before result assembly and relevance gating.

**Acceptance Criteria:**
- [x] Given reranking is disabled, hybrid retrieval preserves fused ordering.
- [x] Given reranking is enabled, the top candidate block is sorted by descending cross-encoder score and the unscored tail stays after it.
- [x] Given JSON output, reranked results expose `rerank_score` alongside the original retrieval `score`.
- [x] Given reranker failure, retrieval degrades to the fused baseline instead of failing.

**Linked Tests:** TS-SEARCH-374
**Dependencies:** RFC019

### NFR-CACHE-830: Conservative Disk Cache Read Failures
**Status:** Implemented
**Priority:** Medium

**Requirement:** The disk-backed rerank-score, query-embedding, and answer caches shall treat read I/O failures as cache misses without evicting entries, while evicting entries that fail parsing, schema, checksum, or value validation.
**Rationale:** Transient filesystem failures should not turn valid, expensive-to-recompute cache records into permanent misses.

**Acceptance Criteria:**
- [x] Given a cached entry and a transient read failure such as `EACCES` or `EIO`, when the cache is read, then it shall return a miss without evicting the entry or recording corruption.
- [x] Given malformed JSON or a failed schema, checksum, or value validation, when the cache is read, then it shall record corruption and evict the entry.
- [x] Given a missing entry, when the cache is read, then it shall return a miss without recording corruption.
- [x] Given the existing cache test suites, when they run, then valid disk hits, eviction, and corruption handling shall remain green.

**Linked Tests:** TS-CACHE-830
**Dependencies:** Existing rerank-score, query-embedding, and answer cache storage paths.

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

### FR-CLI-832: Unknown Knowledge-Base Suggestions
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall explain an unknown knowledge-base name with a bounded list of available knowledge bases and, when sufficiently close, a nearest-name suggestion.
**Rationale:** A mistyped `--kb` value currently forces users to run `kb list` separately and retry, unlike the CLI's existing command and flag typo guidance.

**Acceptance Criteria:**
- [x] Given an unknown `--kb` value, when `kb search` runs in dense mode, then stderr shall include the available knowledge-base list and a nearest-name suggestion when one passes the shared Levenshtein threshold.
- [x] Given an unknown `--kb` value, when `kb search --mode=lexical` runs, then stderr shall include the same bounded list and suggestion behavior.
- [x] Given many available knowledge bases, when an unknown name is reported, then the list shall remain bounded and ordered by closeness with deterministic tie-breaking.
- [x] Given a valid knowledge-base name or a root that cannot be enumerated, then existing successful behavior and the original not-found diagnostic shall remain unchanged.

**Linked Tests:** TS-CLI-832
**Dependencies:** Existing `listKnowledgeBases` and Levenshtein typo-suggestion logic.

### FR-CLI-833: Safe Note Tag Mutation
**Status:** Implemented
**Priority:** Medium

**Requirement:** The system shall provide `kb tag <note>` to preview and, only after explicit confirmation, atomically add or remove tags in one note's YAML frontmatter while preserving the note body and honoring the per-KB write policy.
**Rationale:** Tags are used for retrieval filters and facet discovery, but manual YAML edits are error-prone and can corrupt a note or bypass the KB's write policy.

**Acceptance Criteria:**
- [x] Given a valid note, when `kb tag <note> --add <tag>` or `--remove <tag>` runs without `--yes`, then the command shall print the proposed tag change and leave the note byte-identical.
- [x] Given a valid note and `--yes`, when tags are added or removed, then only the `tags:` frontmatter value shall change and the body below the closing fence shall remain byte-identical.
- [x] Given malformed or invalid frontmatter, when a tag mutation is requested, then the command shall reject it before any write.
- [x] Given a KB whose `.kb-policy.json` denies mutations, when `kb tag ... --yes` runs, then the command shall fail without changing the note.
- [x] Given a successful mutation, when the note is parsed by `kb tags`, then the resulting tag set shall be reported for that note.

**Linked Tests:** TS-CLI-833
**Dependencies:** Existing `parseFrontmatter`, `file-mutation`, and `kb-write-policy` helpers.

### FR-CLI-857: Knowledge-Base Document Listing
**Status:** Implemented
**Priority:** Medium

**Requirement:** The system shall provide a read-only `kb ls` command that lists ingestable, non-quarantined documents by knowledge base, with optional subtree, metadata, and machine-readable output filters.
**Rationale:** CLI users need to discover KB-relative paths before using commands such as `kb remember --append`, `kb promote`, `kb cite`, and `kb feedback --source`; the MCP resources surface already exposes this inventory but the CLI does not.

**Acceptance Criteria:**
- [x] Given an existing knowledge base, when `kb ls <kb>` runs, then stdout shall contain one KB-relative path for every ingestable, non-quarantined document.
- [x] Given no positional knowledge base, when `kb ls` runs, then stdout shall identify documents from every valid knowledge base with deterministic ordering.
- [x] Given `--prefix=<path>`, when listing runs, then only documents in that KB-relative subtree shall be returned and traversal escapes shall be rejected.
- [x] Given `--long`, when listing runs, then output shall include each document's `tier`, `status`, `type`, and filesystem `mtime` metadata.
- [x] Given `--format=json`, when listing runs, then stdout shall be valid `kb.ls.v1` JSON with stable knowledge-base, path, and optional long metadata fields.
- [x] Given ingest filters or quarantine entries already used by `resources/list`, when listing runs, then the CLI shall apply the same exclusions.

**Linked Tests:** TS-CLI-857
**Dependencies:** Existing `enumerateIngestableKbFiles`, ingest filters, quarantine manifest, and `parseFrontmatter`.

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

### NFR-SEARCH-834: Query-time index corruption degrades safely
**Status:** Implemented
**Priority:** Medium

**Requirement:** The search path shall handle a corrupt or missing persisted
index artifact at query time as a classified degradation or partial result,
without an uncaught exception or process crash.

**Rationale:** Read-path corruption is a distinct failure mode from ingest and
save failures. The query-serving daemon needs deterministic coverage for its
graceful-degradation contract.

**Acceptance Criteria:**
- [x] A truncated or garbage FAISS index produces a classified degradation or
  partial result and never an uncaught throw.
- [x] Torn lexical-index JSON produces a classified degradation or partial
  result and never an uncaught throw.
- [x] A missing or short metadata sidecar produces a classified degradation or
  partial result and never an uncaught throw.
- [x] The scenario runs deterministically through `npm run test:chaos`.

**Linked Tests:** [TS-SEARCH-834](../../tests/chaos/scenarios/search-faults.test.ts)
**Dependencies:** Existing chaos fault harness and search degradation paths.

## LLM Egress and Relevance Gate

### NFR-SEC-829: `no_llm_context` LLM Egress Enforcement
**Status:** Implemented
**Priority:** Critical

**Requirement:** The system shall exclude chunks marked `kb_policy.no_llm_context: true` from every LLM prompt generated during contextual-preface ingest and relevance-gate judging, while preserving those chunks as unjudged retrieval results.
**Rationale:** The sensitivity policy is a confidentiality control. A chunk explicitly marked as unavailable to LLMs must not reach either indexing-time preface generation or query-time relevance judging.

**Acceptance Criteria:**
- [x] Given a chunk with `kb_policy.no_llm_context: true`, when contextual-preface ingest runs, then it shall produce no preface and shall not pass the document body to the LLM.
- [x] Given mixed gated candidates, when relevance judging runs, then no policy-excluded candidate content shall appear in the judge messages.
- [x] Given policy-excluded candidates, when the relevance gate runs, then those candidates shall remain in the result set without being judged.
- [x] Given non-sensitive chunks, when either path runs, then existing preface generation and judge behavior shall remain unchanged.
- [x] Given a stale candidate whose source policy cannot be read or parsed, when relevance judging runs, then the candidate shall remain retrievable but shall be excluded from the judge prompt.

**Linked Tests:** TS-SEC-829 (`src/contextual-preface.test.ts`, `src/file-ingest.test.ts`, `src/relevance-gate.test.ts`)
**Dependencies:** Existing `excludesLlmContext` sensitivity-policy helper.

## Relevance Gate (RFC 018)

### FR-GATE-EVAL-369: Gate Validation Harness
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall provide `kb eval-gate` as a fixture-driven harness that measures whether the RFC 018 relevance gate improves downstream answer quality before and after enabling it in production.

**Acceptance Criteria:**
- [x] Given a valid gate-eval fixture, when `kb eval-gate` runs, then the harness emits a stable report with the three pre-registered numbers (`empty_verdict_fire_rate`, `per_chunk_drop_no_good_answer_delta`, `judge_false_empty_rate`).
- [x] Given no reachable LLM endpoint, when `kb eval-gate` runs without `--m1`, then the harness falls back to the offline causal model and still produces a report.
- [x] Given `--m1`, when no endpoint is reachable, then the harness exits non-zero rather than producing a misleading simulated canary report.

**Linked Tests:** TS-GATE-EVAL-369
**Dependencies:** RFC018

### FR-GATE-379: Stage A Floor and Stage B LLM Judge
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall apply a configurable Stage A statistical floor and an optional Stage B LLM judge to retrieval results when `KB_RELEVANCE_GATE=on` or `--gate` is set, fail-soft on judge failures, and only fire an empty verdict when `KB_GATE_EMPTY_VERDICT=on`.

**Acceptance Criteria:**
- [x] Given the gate is off, when retrieval runs, then the gate shall not invoke any LLM call and shall not alter the result set.
- [x] Given Stage A is on, when a candidate scores strictly below `KB_GATE_SCORE_FLOOR`, then it shall be dropped from the gated candidate set.
- [x] Given Stage B is eligible, when the LLM judge times out or returns an invalid verdict, then the gate shall degrade to retrieval and emit a `gate.degraded` canonical event.
- [x] Given `KB_GATE_EMPTY_VERDICT=off`, when the gate's terminal verdict is empty, then the search shall return the pre-gate top-k instead of an empty result.

**Linked Tests:** TS-GATE-379
**Dependencies:** RFC018

### FR-GATE-422: Untrusted Task-Context Policy
**Status:** Implemented
**Priority:** High

**Requirement:** The system shall apply a configurable `KB_GATE_TASK_CONTEXT_MODE` policy to argv-supplied task context that blocks or warns when content is suspicious (long argv, prompt-injection signals).

**Acceptance Criteria:**
- [x] Given the default `warn` mode, when argv task context is long or carries injection signals, then `kb search` shall log a warning to stderr but continue.
- [x] Given `strict` mode, when argv task context carries injection signals, then `kb search` shall exit 2.
- [x] Given `--task-context-file=<path>`, when the file content is large, then the argv-length check shall not apply.

**Linked Tests:** TS-GATE-422
**Dependencies:** FR-GATE-379

## Research

### FR-RESEARCH-451: Evidence Plan and Collect
**Status:** Implemented
**Priority:** Medium

**Requirement:** The system shall provide `kb research plan` and `kb research collect` so an agent can split research into a vetted plan step and a single deterministic evidence-collection step.

**Acceptance Criteria:**
- [x] Given a research question, when `kb research plan` runs, then the system shall return a schema-versioned plan listing the query candidates the collector would run.
- [x] Given a research plan, when `kb research collect` runs, then the system shall execute the queries, deduplicate hits across query candidates, and return a single ranked evidence packet with stable per-hit fields.
- [x] Given per-query and total caps, when the collector runs, then the returned packet shall not exceed them.

**Linked Tests:** TS-RESEARCH-451
**Dependencies:** FR-SEARCH-374

### FR-RESEARCH-452: Planner Selection Tightening
**Status:** Implemented
**Priority:** Medium

**Requirement:** The research planner shall refuse to propose query candidates that contain prompt-injection signals or fail the minimum-task-token threshold.

**Acceptance Criteria:**
- [x] Given a question carrying injection signals, when the planner runs, then no candidate referencing the injected text shall appear in the plan envelope.
- [x] Given a degenerate question, when the planner runs, then non-actionable query candidates shall be omitted with a clear `skipped` reason in the report.

**Linked Tests:** TS-RESEARCH-452
**Dependencies:** FR-RESEARCH-451

## Feedback

### FR-FEEDBACK-436: Relevance Feedback Ledger
**Status:** Implemented
**Priority:** Medium

**Requirement:** The system shall record per-KB relevance judgments through `kb feedback add` and let operators promote accumulated judgments for a query into a `kb eval` fixture case via `kb feedback promote`.

**Acceptance Criteria:**
- [x] Given a relevance judgment, when `kb feedback add` runs, then the system shall append a `relevance-feedback.v1` row to `<kb>/.index/relevance-feedback.jsonl` and return the new entry id.
- [x] Given recorded judgments, when `kb feedback list` runs, then the system shall return entries sorted by `created_at` descending and honor `--query` and `--limit`.
- [x] Given recorded judgments, when `kb feedback promote --fixture --yes` runs, then the system shall append one `kb eval` case for the target query to the fixture file.
- [x] Given `--task-context`, when the ledger row is written, then only the SHA-256 of the task context shall be persisted.

**Linked Tests:** TS-FEEDBACK-436
**Dependencies:** FR-RETRIEVAL-EVAL

## Logging and Observability

### FR-LOGS-397: Canonical Log Reader
**Status:** Implemented
**Priority:** Medium

**Requirement:** The system shall provide `kb logs` as a structured reader over `kb-canonical.v1` log lines so operators can retrieve events by request id, query hash, or recency without parsing raw log files by hand.

**Acceptance Criteria:**
- [x] Given a log file containing canonical events, when `kb logs recent --format=json` runs, then the system shall return the latest events with stable scan counts.
- [x] Given a request id or query SHA, when `kb logs show` runs with the matching filter, then the system shall return every matching event in chronological order.
- [x] Given a missing log file, when `kb logs` runs, then the system shall emit a JSON error envelope with `schema_version: "kb.logs.v1"` and exit code 2.

**Linked Tests:** TS-LOGS-397
**Dependencies:** RFC009

### FR-STATS-419: Contextual Preface Stats
**Status:** Implemented
**Priority:** Medium

**Requirement:** The `kb_stats` payload shall include `contextual_preface` cache and failure counters when RFC 017 ingest is enabled and shall omit the block otherwise.

**Acceptance Criteria:**
- [x] Given `KB_CONTEXTUAL_RETRIEVAL=on` and at least one ingest pass, when stats are requested, then the payload shall include `contextual_preface.cache_hits`, `cache_misses`, `failures`, and `last_failure_code`.
- [x] Given the contextual flag is off, when stats are requested, then the `contextual_preface` block shall be absent and the prior payload shape preserved.

**Linked Tests:** TS-STATS-419
**Dependencies:** RFC017

### FR-STATS-442: Remote Transport Stats
**Status:** Implemented
**Priority:** Medium

**Requirement:** The `kb_stats` payload shall include a `remote_transport` counter block when the HTTP or SSE transport is active and shall omit the block under stdio.

**Acceptance Criteria:**
- [x] Given HTTP or SSE transport, when stats are requested, then the payload shall include `remote_transport.request_count`, `auth_failure_count`, and `backoff_active_count`.
- [x] Given stdio transport, when stats are requested, then the `remote_transport` block shall be absent.

**Linked Tests:** TS-STATS-442
**Dependencies:** RFC008

## Reindex

### FR-REINDEX-407: Reindex Status Ledger
**Status:** Implemented
**Priority:** Medium

**Requirement:** The system shall expose `kb reindex status` as a read-only reader over the `.reindex.run.json` ledger so operators can inspect the current or most recent contextual-reindex pass.

**Acceptance Criteria:**
- [x] Given an existing `.reindex.run.json`, when `kb reindex status --format=json` runs, then the system shall report `kb_scope`, `model`, `started_at`, `finished_at`, chunk counters, cache hit rate, and any failure code.
- [x] Given a missing ledger, when the command runs, then the system shall report a clearly-typed "no runs" envelope rather than failing.

**Linked Tests:** TS-REINDEX-407
**Dependencies:** RFC017

### FR-REINDEX-408: Cache-Aware Reindex Estimate
**Status:** Implemented
**Priority:** Medium

**Requirement:** The contextual-reindex estimator shall subtract chunks already present in the preface cache from its wall-clock estimate so re-runs after partial failures report realistic remaining work.

**Acceptance Criteria:**
- [x] Given a populated preface cache, when the estimator runs, then the reported chunk-to-embed count shall exclude cache hits.
- [x] Given an empty cache, when the estimator runs, then the reported count shall equal the total ingestable chunks.

**Linked Tests:** TS-REINDEX-408
**Dependencies:** RFC017

## Serve / Daemon

### FR-SERVE-410: Daemon Lifecycle Probe
**Status:** Implemented
**Priority:** Medium

**Requirement:** The system shall provide `kb serve status` as a read-only probe that reports whether the resident daemon is reachable at the configured `KB_DAEMON_URL` and never starts or stops the daemon itself.

**Acceptance Criteria:**
- [x] Given a reachable daemon, when the probe runs, then the system shall exit 0 with the daemon's pid, uptime, idle timeout, and command list when supplied by `/health`.
- [x] Given no daemon is listening, when the probe runs, then the system shall exit 3 with a clear "no daemon at <url>" message.
- [x] Given a daemon answers with an unusable `/health` payload, when the probe runs, then the system shall exit 1.
- [x] Given an invalid `KB_DAEMON_URL`, when the probe runs, then the system shall exit 2.

**Linked Tests:** TS-SERVE-410

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
