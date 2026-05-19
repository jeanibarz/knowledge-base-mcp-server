# Feature Flags and Defaults

This page is the operator-facing defaults matrix for retrieval, LLM, ingest,
diagnostic, and output knobs. Design RFCs explain why a feature exists; this
page answers what is on in a normal install, where it applies, and how to
verify the active behavior.

## Retrieval and Answering

| Feature | Env var or flag | Default | Surfaces | Status | Per-call override | Validation command |
|---|---|---:|---|---|---|---|
| Retrieval mode | `kb search --mode=dense\|lexical\|hybrid\|auto` | `dense` | CLI search | Implemented | `--mode=...` | `kb search "query" --mode=auto --timing` |
| Refresh before search | `kb search --refresh` | off | CLI search | Implemented | `--refresh` | `kb search "query" --refresh --timing` |
| Active embedding model | `KB_ACTIVE_MODEL` | unset, then `${FAISS_INDEX_PATH}/active.txt`, then legacy provider env | CLI and MCP retrieval | Implemented | `--model=<id>` on CLI, `model_name` on MCP `retrieve_knowledge` | `kb models list` |
| Query embedding cache | `KB_QUERY_CACHE` | on | CLI and MCP retrieval | Implemented | `kb search --no-cache` | `kb doctor --format=json` |
| Query cache memory limit | `KB_QUERY_CACHE_LRU_MAX` | `256` | CLI and MCP retrieval | Implemented | none | `kb doctor --format=json` |
| Query cache disk budget | `KB_QUERY_CACHE_DISK_MAX_MB` | `64` | CLI and MCP retrieval | Implemented | none | `kb doctor --format=json` |
| Local LLM endpoint | `KB_LLM_ENDPOINT` | active `kb llm` profile, then local-research-agent default for `kb ask`; unset for contextual ingest unless supplied | `kb ask`, contextual ingest, gate fallback endpoint | Implemented | `kb ask --endpoint=...`, `--llm-profile=...` | `kb llm status` |
| Gate fallback LLM model id | `KB_LLM_MODEL` | endpoint default | Relevance gate fallback model | Implemented | none | `KB_RELEVANCE_GATE=on KB_LLM_MODEL=<model> kb search "query" --gate --task-context="current task"` |
| Save generated answer | `kb ask --save-transcript --yes` | off | CLI ask write path | Implemented | `--save-transcript --kb=<name> --yes` | `kb ask "question" --kb=<name> --save-transcript --title="..." --yes` |

## Relevance Gate

The RFC 018 gate is recall-negative by design, so it is disabled unless an
operator opts in. With no task context it uses the statistical path only; with
task context it may call an LLM judge. Any judge failure degrades to retrieval
rather than failing the query.

| Feature | Env var or flag | Default | Surfaces | Status | Per-call override | Validation command |
|---|---|---:|---|---|---|---|
| Relevance gate master switch | `KB_RELEVANCE_GATE` | `off` | CLI search and MCP `retrieve_knowledge` | Implemented | `kb search --gate`, `kb search --no-gate`, MCP `gate: "on"\|"off"` | `KB_RELEVANCE_GATE=on kb search "query" --task-context="current task" --timing` |
| Gate task context | `--task-context`, `--task-context-file`, MCP `task_context` | unset | CLI search and MCP retrieval | Implemented | per call only | `kb search "query" --gate --task-context="current task"` |
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

RFC 019 defines the intended cross-encoder reranker surface. These flags are
documented for rollout planning but are not active behavior until the reranker
implementation lands.

| Feature | Env var or flag | Default | Surfaces | Status | Per-call override | Validation command |
|---|---|---:|---|---|---|---|
| Cross-encoder reranker | `KB_RERANK` | `off` | Planned CLI search and MCP retrieval | Planned in RFC 019 | planned `kb search --rerank`, `--no-rerank` | not available until implementation |
| Reranker model | `KB_RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | Planned reranker provider | Planned in RFC 019 | none | not available until implementation |
| Rerank candidate count | `KB_RERANK_TOP_N` | `40` | Planned reranker stage | Planned in RFC 019 | none | not available until implementation |

## Output, Diagnostics, and Logging

| Feature | Env var or flag | Default | Surfaces | Status | Per-call override | Validation command |
|---|---|---:|---|---|---|---|
| Editor URI links | `KB_EDITOR_URI` | `none` | CLI and MCP retrieval output | Implemented | none | `KB_EDITOR_URI=cursor kb search "query" --format=json` |
| Frontmatter extras on wire | `FRONTMATTER_EXTRAS_WIRE_VISIBLE` | `false` | MCP and CLI JSON retrieval output | Implemented | none | `FRONTMATTER_EXTRAS_WIRE_VISIBLE=true kb search "query" --format=json` |
| CLI timing | `--timing` | off | CLI search and ask | Implemented | `--timing` | `kb search "query" --timing` |
| Canonical log format | `KB_LOG_FORMAT` | `both` | Process logs | Implemented | none | `KB_LOG_FORMAT=canonical kb search "query"` |
| Log level | `LOG_LEVEL` | `info` | Process logs | Implemented | none | `LOG_LEVEL=debug kb doctor` |
| Log file | `LOG_FILE` | unset | Process logs | Implemented | none | `LOG_FILE=/tmp/kb.log kb doctor` |
| Mutation audit log | `KB_MUTATION_AUDIT_LOG` | unset | KB write paths | Implemented, opt-in | none | `KB_MUTATION_AUDIT_LOG=/tmp/kb-mutations.jsonl kb remember --kb=<name> --title="..." --stdin --yes` |
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
| Maximum raw file size | `KB_MAX_FILE_BYTES` | `104857600` | Ingest and refresh | Implemented | none | `KB_MAX_FILE_BYTES=1048576 kb search "query" --refresh` |
| Maximum extracted text size | `KB_MAX_EXTRACTED_TEXT_BYTES` | `16777216` | Ingest and refresh | Implemented | none | `KB_MAX_EXTRACTED_TEXT_BYTES=1048576 kb search "query" --refresh` |
| Large-file policy | `KB_LARGE_FILE_POLICY` | `skip` | Ingest and refresh | Implemented | none | `KB_LARGE_FILE_POLICY=error kb search "query" --refresh` |

## Remote Transport

| Feature | Env var or flag | Default | Surfaces | Status | Per-call override | Validation command |
|---|---|---:|---|---|---|---|
| MCP transport | `MCP_TRANSPORT` | stdio | MCP server | Implemented | none | `MCP_TRANSPORT=http MCP_AUTH_TOKEN=<32+ chars> node build/index.js` |
| HTTP/SSE auth token | `MCP_AUTH_TOKEN` | required for non-stdio transports | MCP server | Implemented | none | `MCP_TRANSPORT=http MCP_AUTH_TOKEN=<32+ chars> node build/index.js` |
| Allowed browser origins | `MCP_ALLOWED_ORIGINS` | deny browser origins | HTTP/SSE MCP server | Implemented | none | `MCP_TRANSPORT=http MCP_AUTH_TOKEN=<32+ chars> MCP_ALLOWED_ORIGINS=http://localhost:5173 node build/index.js` |
| HTTP/SSE port | `MCP_PORT` | `8765` | HTTP/SSE MCP server | Implemented | none | `MCP_TRANSPORT=http MCP_AUTH_TOKEN=<32+ chars> MCP_PORT=8765 node build/index.js` |
| Bind address | `MCP_BIND_ADDR` | `127.0.0.1` | HTTP/SSE MCP server | Implemented | none | `MCP_TRANSPORT=http MCP_AUTH_TOKEN=<32+ chars> MCP_BIND_ADDR=127.0.0.1 node build/index.js` |

## Rollout Checklist

1. Confirm the feature is implemented or explicitly planned in the `Status`
   column.
2. Run the validation command in the same shell or MCP-client environment that
   will use the feature.
3. Prefer per-call overrides for diagnostics and one-off experiments.
4. Promote process-level env vars only after `kb doctor` and a representative
   `kb search` or `kb eval` run show the expected behavior.
