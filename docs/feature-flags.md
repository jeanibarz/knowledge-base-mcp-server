# Feature Flags and Defaults

This page is the operator-facing defaults matrix for retrieval, LLM, ingest,
diagnostic, and output knobs. Design RFCs explain why a feature exists; this
page answers what is on in a normal install, where it applies, and how to
verify the active behavior.

## Retrieval and Answering

| Feature | Env var or flag | Default | Surfaces | Status | Per-call override | Validation command |
|---|---|---:|---|---|---|---|
| Retrieval mode | `kb search --mode=dense\|lexical\|hybrid\|auto` | `dense` | CLI search | Implemented | `--mode=...` | `kb search "query" --mode=auto --timing` |
| Neighbor context windows | `kb search --context-before=<n>`, `--context-after=<n>`, `--context-window=<n>` | off | CLI dense search | Implemented, opt-in | per-call flags only | `kb search "runbook rollback" --context-window=1` |
| Advanced retrieval exploration | `kb search --diverse`, `--anti-query=<text>`, `--plus=<text>`, `--minus=<text>` | off | CLI search | Implemented, opt-in | per-call flags only | `kb search "agent evidence" --diverse --format=json` |
| Query decomposition | `kb search --mode=hybrid --decompose`, `--decompose-provider=rule\|llm`, `--decompose-max-subqueries=<n>`, `--decompose-max-iterations=<n>`, `--decompose-max-candidates=<n>`, `--decompose-timeout-ms=<n>` | off | CLI hybrid search, BEIR `hybrid+decompose` benchmark mode | Implemented, opt-in | per-call flags only; `llm` provider uses `KB_DECOMPOSE_LLM_ENDPOINT` or `KB_LLM_ENDPOINT` and falls back to `rule` | `kb search "multi hop query" --mode=hybrid --decompose --format=json` |
| Refresh before search | `kb search --refresh` | off | CLI search | Implemented | `--refresh` | `kb search "query" --refresh --timing` |
| Active embedding model | `KB_ACTIVE_MODEL` | unset, then `${FAISS_INDEX_PATH}/active.txt`, then legacy provider env | CLI and MCP retrieval | Implemented | `--model=<id>` on CLI, `model_name` on MCP `retrieve_knowledge` | `kb models list` |
| Query embedding cache | `KB_QUERY_CACHE` | on | CLI and MCP retrieval | Implemented | `kb search --no-cache` | `kb doctor --format=json` |
| Query cache memory limit | `KB_QUERY_CACHE_LRU_MAX` | `256` | CLI and MCP retrieval | Implemented | none | `kb doctor --format=json` |
| Query cache disk budget | `KB_QUERY_CACHE_DISK_MAX_MB` | `64` | CLI and MCP retrieval | Implemented | none | `kb doctor --format=json` |
| Local LLM endpoint | `KB_LLM_ENDPOINT` | active `kb llm` profile, then local-research-agent default for `kb ask`; unset for contextual ingest unless supplied | `kb ask`, contextual ingest, gate fallback endpoint | Implemented | `kb ask --endpoint=...`, `--llm-profile=...` | `kb llm status` |
| Fake LLM | `KB_LLM_FAKE` | `off` | `kb ask`, contextual ingest, relevance-gate Stage B | Implemented, dev/test fixture | none | `KB_LLM_FAKE=on kb ask "question" --kb=<name>` |
| Fake LLM rules | `KB_LLM_FAKE_RULES` | unset | Fake LLM answers, prefaces, judge verdicts | Implemented | none | `KB_LLM_FAKE=on KB_LLM_FAKE_RULES=/path/to/rules.json kb ask "question"` |
| Gate fallback LLM model id | `KB_LLM_MODEL` | endpoint default | Relevance gate fallback model | Implemented | none | `KB_RELEVANCE_GATE=on KB_LLM_MODEL=<model> kb search "query" --gate --task-context="current task"` |
| Save generated answer | `kb ask --save-transcript --yes` | off | CLI ask write path | Implemented | `--save-transcript --kb=<name> --yes` | `kb ask "question" --kb=<name> --save-transcript --title="..." --yes` |
| Frontmatter sensitivity policy | `kb_policy.no_llm_context`, `kb_policy.resource_read`, `kb_policy.sensitivity` | unset | `kb ask`, MCP `ask_knowledge`, MCP `resources/read` | Implemented, author-controlled | per-document frontmatter | add `kb_policy: { no_llm_context: true }` and run `kb ask ... --format=json` |

Neighbor context windows are dense-only. They expand the returned context after
ranking and do not make neighboring chunks influence the dense score. See
[Neighbor Context Search Windows](search-neighbor-context.md) for examples,
markdown/JSON output shape, and when wider windows dilute results.

## Relevance Gate

The RFC 018 gate is recall-negative by design, so it is disabled unless an
operator opts in. With no task context it uses the statistical path only; with
task context it may call an LLM judge. Any judge failure degrades to retrieval
rather than failing the query.

Task context is a trust boundary — it is concatenated into the judge prompt.
`KB_GATE_TASK_CONTEXT_MODE` controls how `kb search` treats it: `warn` (the
default) advises on stderr when `--task-context` argv is long or prompt-like
(prefer `--task-context-file`) or carries prompt-injection signals; `strict`
refuses injection-signal-bearing task context with exit code 2; `off` disables
both checks.

| Feature | Env var or flag | Default | Surfaces | Status | Per-call override | Validation command |
|---|---|---:|---|---|---|---|
| Relevance gate master switch | `KB_RELEVANCE_GATE` | `off` | CLI search and MCP `retrieve_knowledge` | Implemented | `kb search --gate`, `kb search --no-gate`, MCP `gate: "on"\|"off"` | `KB_RELEVANCE_GATE=on kb search "query" --task-context="current task" --timing` |
| Gate task context | `--task-context`, `--task-context-file`, MCP `task_context` | unset | CLI search and MCP retrieval | Implemented | per call only | `kb search "query" --gate --task-context="current task"` |
| Gate task-context policy | `KB_GATE_TASK_CONTEXT_MODE` | `warn` | `kb search` task-context input | Implemented | none | `KB_GATE_TASK_CONTEXT_MODE=strict kb search "query" --gate --task-context="current task"` |
| Gate task-context argv limit | `KB_GATE_TASK_CONTEXT_ARGV_MAX` | `600` | `kb search` task-context policy | Implemented | none | `KB_GATE_TASK_CONTEXT_ARGV_MAX=200 kb search "query" --gate --task-context="current task"` |
| Gate dense-distance floor | `KB_GATE_SCORE_FLOOR` | `0.95` | Gate stage A1 | Implemented | none | `KB_GATE_SCORE_FLOOR=0.95 kb search "query" --gate --timing` |
| Gate judge input cap | `KB_GATE_JUDGE_INPUT` | `10` | Gate stage B | Implemented | none | `KB_RELEVANCE_GATE=on KB_GATE_JUDGE_INPUT=5 kb search "query" --task-context="current task"` |
| Gate LLM timeout | `KB_GATE_LLM_TIMEOUT_MS` | `8000` | Gate stage B | Implemented | none | `KB_GATE_LLM_TIMEOUT_MS=8000 kb search "query" --gate --task-context="current task"` |
| Gate minimum task-context signal | `KB_GATE_MIN_TASK_TOKENS` | `8` | Gate stage B eligibility | Implemented | none | `KB_GATE_MIN_TASK_TOKENS=8 kb search "query" --gate --task-context="short task"` |
| Gate empty verdict | `KB_GATE_EMPTY_VERDICT` | `off` | Gate terminal verdict | Implemented, opt-in after false-empty findings | none | `KB_GATE_EMPTY_VERDICT=on kb search "query" --gate --task-context="current task"` |
| Gate judge endpoint | `KB_GATE_LLM_ENDPOINT` | falls back to `KB_LLM_ENDPOINT`; unset means statistical path/degrade | Gate stage B | Implemented | none | `KB_GATE_LLM_ENDPOINT=http://127.0.0.1:8080/v1/chat/completions kb search "query" --gate --task-context="current task"` |
| Gate judge model | `KB_GATE_LLM_MODEL` | falls back to `KB_LLM_MODEL`; otherwise endpoint default | Gate stage B | Implemented | none | `KB_GATE_LLM_MODEL=<model> kb search "query" --gate --task-context="current task"` |

## Contextual Retrieval at Ingest

Contextual retrieval changes what is embedded during ingest, not the chunk text
returned to callers. Existing non-contextual indexes keep working when the flag
is off.

| Feature | Env var or flag | Default | Surfaces | Status | Per-call override | Validation command |
|---|---|---:|---|---|---|---|
| Contextual prefaces | `KB_CONTEXTUAL_RETRIEVAL` | `off` | Ingest, reindex, refresh | Implemented behind opt-in | `kb reindex --with-context` controls the reindex path; env still gates generation | `KB_CONTEXTUAL_RETRIEVAL=on KB_LLM_ENDPOINT=http://127.0.0.1:8080/v1/chat/completions kb reindex --with-context` |
| Preface token budget | `KB_CONTEXTUAL_MAX_TOKENS` | `150` | Contextual ingest LLM call | Implemented | none | `KB_CONTEXTUAL_RETRIEVAL=on KB_CONTEXTUAL_MAX_TOKENS=120 KB_LLM_ENDPOINT=http://127.0.0.1:8080/v1/chat/completions kb reindex --with-context` |
| Preface LLM endpoint | `KB_LLM_ENDPOINT` | unset for contextual ingest | Contextual ingest | Implemented | none | `KB_CONTEXTUAL_RETRIEVAL=on KB_LLM_ENDPOINT=http://127.0.0.1:8080/v1/chat/completions kb reindex --with-context` |

`kb reindex --with-context` accepts `--kb=<name>`, but it is a guard and
estimator hint, not a scoped rebuild: the rebuild always covers the whole
single-index-per-model FAISS index. `--kb` only narrows the runtime estimate
and the LRA cron-window guard, and validates that the named KBs exist. A
partial rebuild is impossible without orphaning the other shelves' vectors;
see RFC 017 §5.

Hard-coded contextual-ingest constants are intentionally not env flags:
48,000 character document truncation, 30 second LLM timeout, 2 retries, 5
consecutive timeouts before circuit breaking, and the reindex guard window
documented in RFC 017.

## Reranker

RFC 019 defines the optional cross-encoder reranker surface. The reranker runs
after hybrid dense/BM25 fusion and before the relevance gate. It is fail-soft:
provider load or scoring failures degrade to the fused order.

| Feature | Env var or flag | Default | Surfaces | Status | Per-call override | Validation command |
|---|---|---:|---|---|---|---|
| Cross-encoder reranker | `KB_RERANK` | `off` | CLI hybrid search, MCP hybrid retrieval, retrieval eval | Implemented, opt-in | `kb search --rerank`, `kb search --no-rerank`, MCP `rerank: "on"\|"off"` | `KB_RERANK=on kb search "query" --mode=hybrid --timing --format=json` |
| Reranker model | `KB_RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | Local `@huggingface/transformers` provider | Implemented | none | `KB_RERANK=on kb doctor --format=json` |
| Rerank candidate count | `KB_RERANK_TOP_N` | `40` | Reranker stage | Implemented | none | `KB_RERANK_TOP_N=20 KB_RERANK=on kb search "query" --mode=hybrid --timing` |
| Skip-rerank fallback (per-domain gate) | `KB_RERANK_SKIP_DOMAINS` | _(empty)_ | Reranker stage (CLI/MCP/eval) | Implemented | none | `KB_RERANK=on KB_RERANK_SKIP_DOMAINS=code,skills kb search "query" --kb code --mode=hybrid --timing` |

## Untrusted Content Hardening

Retrieved chunk text is treated as untrusted by default — the injection guard
detects prompt-injection signals (system-role markers, instruction overrides,
bidi controls, zero-width chars, unicode tag chars) and either tags or wraps
the offending content before it reaches the agent. The default mode is `tag`,
which adds a metadata signal without altering content. `wrap` and `both`
additionally fence content with sentinel strings derived from the wrap-open and
wrap-close vars below.

| Feature | Env var or flag | Default | Surfaces | Status | Per-call override | Validation command |
|---|---|---:|---|---|---|---|
| Untrusted-content guard mode | `KB_INJECTION_GUARD` | `tag` | MCP and CLI retrieval output | Implemented | none | `KB_INJECTION_GUARD=both kb search "query" --format=json` |
| Guard bypass list | `KB_INJECTION_GUARD_BYPASS_KBS` | empty | Retrieval guard | Implemented | none | `KB_INJECTION_GUARD_BYPASS_KBS=trusted-runbook kb search "query"` |
| Wrap-open sentinel | `KB_INJECTION_GUARD_WRAP_OPEN` | `<untrusted-doc src="{source}">` | Retrieval guard wrap modes | Implemented | none | `KB_INJECTION_GUARD=wrap KB_INJECTION_GUARD_WRAP_OPEN='<<UNTRUSTED:{source}>>' kb search "query"` |
| Wrap-close sentinel | `KB_INJECTION_GUARD_WRAP_CLOSE` | `</untrusted-doc>` | Retrieval guard wrap modes | Implemented | none | `KB_INJECTION_GUARD=wrap KB_INJECTION_GUARD_WRAP_CLOSE='<<END>>' kb search "query"` |

## Output, Diagnostics, and Logging

| Feature | Env var or flag | Default | Surfaces | Status | Per-call override | Validation command |
|---|---|---:|---|---|---|---|
| Editor URI links | `KB_EDITOR_URI` | `none` | CLI and MCP retrieval output | Implemented | none | `KB_EDITOR_URI=cursor kb search "query" --format=json` |
| Frontmatter extras on wire | `FRONTMATTER_EXTRAS_WIRE_VISIBLE` | `false` | MCP and CLI JSON retrieval output | Implemented | none | `FRONTMATTER_EXTRAS_WIRE_VISIBLE=true kb search "query" --format=json` |
| CLI timing | `--timing` | off | CLI search and ask; aggregate filter selectivity diagnostics for non-empty filtered dense search | Implemented | `--timing` | `kb search "query" --timing` |
| Compact search output | `kb search --format=compact` | `md` | CLI search | Implemented | `--format=compact` | `kb search "query" --format=compact` |
| Search pager | `KB_PAGER`, `kb search --pager` | off; `less -R` when enabled without a pager env | CLI search markdown/compact output on TTY stdout | Implemented, opt-in | `--pager`, `--no-pager` | `KB_PAGER='less -R' kb search "query" --pager --k=30` |
| Batch JSONL search input | `kb search --batch-jsonl` | off | CLI search | Implemented | `--batch-jsonl < queries.jsonl` | `printf '{"query":"q1"}\n{"query":"q2"}\n' \| kb search --batch-jsonl` |
| Canonical log format | `KB_LOG_FORMAT` | `both` | Process logs | Implemented | none | `KB_LOG_FORMAT=canonical kb search "query"` |
| Verbose MCP server tracing | `KB_LOG_VERBOSE` | unset | `KnowledgeBaseServer` lifecycle logs | Implemented, opt-in | none | `KB_LOG_VERBOSE=1 node build/index.js` |
| Log level | `LOG_LEVEL` | `info` | Process logs | Implemented | none | `LOG_LEVEL=debug kb doctor` |
| Log file | `LOG_FILE` | unset | Process logs | Implemented | none | `LOG_FILE=/tmp/kb.log kb doctor` |
| Canonical log reader | `kb logs show --request-id=<id>` | reads configured canonical log | `kb logs` | Implemented | none | `kb logs recent --limit=20 --format=json` |
| Config schema validation | `kb config validate` | process environment | CLI preflight / CI | Implemented | `--file=<path>` | `kb config validate --file=.env --format=json` |
| Mutation audit log | `KB_MUTATION_AUDIT_LOG` | unset | KB write paths | Implemented, opt-in | none | `KB_MUTATION_AUDIT_LOG=/tmp/kb-mutations.jsonl kb remember --kb=<name> --title="..." --stdin --yes` |
| OpenMetrics export | `KB_METRICS_EXPORT` | `off` | `kb serve` and HTTP/SSE transport `/metrics` | Implemented, opt-in | none | `KB_METRICS_EXPORT=on kb serve` then `curl http://127.0.0.1:17799/metrics` |
| Tool description overrides | `RETRIEVE_KNOWLEDGE_DESCRIPTION`, `LIST_KNOWLEDGE_BASES_DESCRIPTION`, `LIST_MODELS_DESCRIPTION`, `KB_STATS_DESCRIPTION` | built-in descriptions | MCP server tool metadata | Implemented | none; set before server start | restart MCP server and inspect tool descriptions |

## Ingest and Storage

| Feature | Env var or flag | Default | Surfaces | Status | Per-call override | Validation command |
|---|---|---:|---|---|---|---|
| KB root | `KNOWLEDGE_BASES_ROOT_DIR` | `$HOME/knowledge_bases` | CLI and MCP | Implemented | none | `kb list` |
| FAISS index path | `FAISS_INDEX_PATH` | `$KNOWLEDGE_BASES_ROOT_DIR/.faiss` | CLI and MCP | Implemented | none | `kb doctor --format=json` |
| Embedding provider | `EMBEDDING_PROVIDER` | `huggingface` | CLI and MCP retrieval/ingest | Implemented | register/query a model with `kb models` where available | `kb doctor` |
| Ollama endpoint | `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama embedding provider | Implemented | none | `EMBEDDING_PROVIDER=ollama kb doctor` |
| Ollama embedding model | `OLLAMA_MODEL` | `dengcao/Qwen3-Embedding-0.6B:Q8_0` | Ollama embedding provider | Implemented | active model selection through `kb models` | `EMBEDDING_PROVIDER=ollama kb models list` |
| OpenAI embedding model | `OPENAI_MODEL_NAME` | `text-embedding-3-small` | OpenAI embedding provider | Implemented | active model selection through `kb models` | `EMBEDDING_PROVIDER=openai kb doctor` |
| OpenAI API key | `OPENAI_API_KEY` | required for OpenAI | OpenAI embedding provider | Implemented | none | `EMBEDDING_PROVIDER=openai kb doctor` |
| HuggingFace embedding model | `HUGGINGFACE_MODEL_NAME` | `BAAI/bge-small-en-v1.5` | HuggingFace embedding provider | Implemented | active model selection through `kb models` | `EMBEDDING_PROVIDER=huggingface kb doctor` |
| HuggingFace router provider | `HUGGINGFACE_PROVIDER` | `hf-inference` | HuggingFace embedding provider | Implemented | none | `EMBEDDING_PROVIDER=huggingface kb doctor` |
| HuggingFace endpoint URL | `HUGGINGFACE_ENDPOINT_URL` | router URL for the selected model | HuggingFace embedding provider | Implemented | none | `HUGGINGFACE_ENDPOINT_URL=<url> kb doctor` |
| HuggingFace API key | `HUGGINGFACE_API_KEY` | required for HuggingFace | HuggingFace embedding provider | Implemented | none | `EMBEDDING_PROVIDER=huggingface kb doctor` |
| Extra ingest extensions | `INGEST_EXTRA_EXTENSIONS` | empty | Ingest and refresh | Implemented | none | `INGEST_EXTRA_EXTENSIONS=.pdf kb search "known phrase" --refresh` |
| Extra ingest exclusions | `INGEST_EXCLUDE_PATHS` | empty | Ingest and refresh | Implemented | none | `INGEST_EXCLUDE_PATHS="drafts/**" kb search "known phrase" --refresh` |
| Refresh quiescence guard | `KB_REFRESH_QUIESCE_MS` | `0` | Ingest and refresh | Implemented, opt-in | none | `KB_REFRESH_QUIESCE_MS=1000 kb search "query" --refresh` |
| Maximum raw file size | `KB_MAX_FILE_BYTES` | `104857600` | Ingest and refresh | Implemented | none | `KB_MAX_FILE_BYTES=1048576 kb search "query" --refresh` |
| Maximum extracted text size | `KB_MAX_EXTRACTED_TEXT_BYTES` | `16777216` | Ingest and refresh | Implemented | none | `KB_MAX_EXTRACTED_TEXT_BYTES=1048576 kb search "query" --refresh` |
| Extracted text cache pruning | `kb cache extracted-text --max-age-days=<n>`, `--max-size-mb=<n>`, `--dry-run`, `--yes` | dry-run | CLI cache, `kb doctor` inventory | Implemented, read-only by default | per-call flags only | `kb cache extracted-text --max-age-days=30 --max-size-mb=512` |
| Large-file policy | `KB_LARGE_FILE_POLICY` | `skip` | Ingest and refresh | Implemented | none | `KB_LARGE_FILE_POLICY=error kb search "query" --refresh` |
| Ingest secret scan | `KB_INGEST_SECRET_SCAN` | `off` | Ingest and refresh | Implemented, opt-in; `KB_SECRET_SCAN_BYPASS_KBS=<csv>` bypasses trusted credential-example KBs | none | `KB_INGEST_SECRET_SCAN=on kb search "query" --refresh` then `kb quarantine list --reason=secret_detected` |
| Splitter chunk size | `KB_CHUNK_SIZE` | `1000` | Ingest and refresh | Implemented | none | `KB_CHUNK_SIZE=500 kb search "query" --refresh` |
| Splitter chunk overlap | `KB_CHUNK_OVERLAP` | `200` (auto-scales as `floor(chunkSize/5)` when only `KB_CHUNK_SIZE` is set) | Ingest and refresh | Implemented | none | `KB_CHUNK_SIZE=500 KB_CHUNK_OVERLAP=100 kb search "query" --refresh` |
| Indexing batch size | `INDEXING_BATCH_SIZE` | `64` (Ollama: `16`) | Embedding ingest | Implemented | none | `INDEXING_BATCH_SIZE=32 kb search "query" --refresh` |
| FAISS index type | `KB_INDEX_TYPE=flat\|sq8`, or `kb models add --index-type=flat\|sq8` | `flat` | Per-model FAISS index creation | Implemented, opt-in SQ8 | model registration flag | `KB_INDEX_TYPE=sq8 kb models add ollama nomic-embed-text --dry-run` |
| Filesystem watcher | `KB_FS_WATCH` | off | KB root watcher (auto-refresh on file change) | Implemented, opt-in | none | `KB_FS_WATCH=1 node build/index.js` |
| FS watcher debounce | `KB_FS_WATCH_DEBOUNCE_MS` | `250` | KB root watcher | Implemented | none | `KB_FS_WATCH=1 KB_FS_WATCH_DEBOUNCE_MS=500 node build/index.js` |
| Index version retention | `KB_INDEX_VERSION_RETENTION` | `2` | FAISS version rotation | Implemented | none | `KB_INDEX_VERSION_RETENTION=4 kb reindex --with-context` |
| Per-KB age budget | `KB_AGE_BUDGET_HOURS_<KB>` or `KB_AGE_BUDGET_HOURS` (global fallback) | unset | `kb doctor`, search freshness footer | Implemented, opt-in | none | `KB_AGE_BUDGET_HOURS=24 kb doctor --format=json` |

## Remote Transport

| Feature | Env var or flag | Default | Surfaces | Status | Per-call override | Validation command |
|---|---|---:|---|---|---|---|
| MCP transport | `MCP_TRANSPORT` | stdio | MCP server | Implemented | none | `MCP_TRANSPORT=http MCP_AUTH_TOKEN=<32+ chars> node build/index.js` |
| HTTP/SSE auth token | `MCP_AUTH_TOKEN` | required for non-stdio transports | MCP server | Implemented | none | `MCP_TRANSPORT=http MCP_AUTH_TOKEN=<32+ chars> node build/index.js` |
| Allowed browser origins | `MCP_ALLOWED_ORIGINS` | deny browser origins | HTTP/SSE MCP server | Implemented | none | `MCP_TRANSPORT=http MCP_AUTH_TOKEN=<32+ chars> MCP_ALLOWED_ORIGINS=http://localhost:5173 node build/index.js` |
| HTTP/SSE port | `MCP_PORT` | `8765` | HTTP/SSE MCP server | Implemented | none | `MCP_TRANSPORT=http MCP_AUTH_TOKEN=<32+ chars> MCP_PORT=8765 node build/index.js` |
| Bind address | `MCP_BIND_ADDR` | `127.0.0.1` | HTTP/SSE MCP server | Implemented | none | `MCP_TRANSPORT=http MCP_AUTH_TOKEN=<32+ chars> MCP_BIND_ADDR=127.0.0.1 node build/index.js` |
| Failed auth backoff threshold | `MCP_AUTH_BACKOFF_THRESHOLD` | `5` | HTTP/SSE MCP server | Implemented | none | `MCP_TRANSPORT=http MCP_AUTH_TOKEN=<32+ chars> MCP_AUTH_BACKOFF_THRESHOLD=3 node build/index.js` |
| Failed auth backoff window | `MCP_AUTH_BACKOFF_MS` | `30000` | HTTP/SSE MCP server | Implemented | none | `MCP_TRANSPORT=http MCP_AUTH_TOKEN=<32+ chars> MCP_AUTH_BACKOFF_MS=60000 node build/index.js` |
| Failed auth backoff address cap | `MCP_AUTH_BACKOFF_MAX_ENTRIES` | `1024` | HTTP/SSE MCP server | Implemented | none | `MCP_TRANSPORT=http MCP_AUTH_TOKEN=<32+ chars> MCP_AUTH_BACKOFF_MAX_ENTRIES=2048 node build/index.js` |

## Daemon and CLI Fast-Path

`kb serve` runs a long-lived CLI helper process. CLI commands that opt in (and
`kb serve status`) reach it over loopback HTTP, avoiding cold-start overhead.

| Feature | Env var or flag | Default | Surfaces | Status | Per-call override | Validation command |
|---|---|---:|---|---|---|---|
| Daemon URL | `KB_DAEMON_URL` | composed from `KB_DAEMON_HOST` (default `127.0.0.1`) and `KB_DAEMON_PORT` (default `17799`) when unset | `kb serve` clients, `kb doctor --endpoints`, `kb serve status` | Implemented | none | `KB_DAEMON_URL=http://127.0.0.1:17799 kb serve status` |
| Daemon host | `KB_DAEMON_HOST` | `127.0.0.1` | Daemon URL composition | Implemented | none | `KB_DAEMON_HOST=127.0.0.1 KB_DAEMON_PORT=17799 kb serve` |
| Daemon port | `KB_DAEMON_PORT` | `17799` | Daemon URL composition | Implemented | none | `KB_DAEMON_PORT=18888 kb serve` |

## Managed LLM Profiles

`kb llm` writes profile configuration, lease state, and managed systemd unit
files under platform-appropriate paths. Operators can redirect any of the three
without changing source.

| Feature | Env var or flag | Default | Surfaces | Status | Per-call override | Validation command |
|---|---|---:|---|---|---|---|
| LLM profile config dir | `KB_LLM_CONFIG_DIR` | `$XDG_CONFIG_HOME/kb-llm` or `~/.config/kb-llm` | `kb llm` profile files | Implemented | none | `KB_LLM_CONFIG_DIR=/tmp/kb-llm kb llm status` |
| LLM lease/state dir | `KB_LLM_STATE_DIR` | `$XDG_STATE_HOME/kb-llm` or `~/.local/state/kb-llm` | `kb llm` lease files and managed-runner stdout/stderr | Implemented | none | `KB_LLM_STATE_DIR=/tmp/kb-llm-state kb llm status` |
| Managed systemd unit dir | `KB_LLM_SYSTEMD_USER_DIR` | `~/.config/systemd/user` | `kb llm install` / `uninstall` for `kb-llm@<profile>.service` | Implemented | none | `KB_LLM_SYSTEMD_USER_DIR=$HOME/.config/systemd/user kb llm install --profile=qwen ...` |

## Rollout Checklist

1. Confirm the feature is implemented or explicitly planned in the `Status`
   column.
2. Run the validation command in the same shell or MCP-client environment that
   will use the feature.
3. Prefer per-call overrides for diagnostics and one-off experiments.
4. Promote process-level env vars only after `kb doctor` and a representative
   `kb search` or `kb eval` run show the expected behavior.
