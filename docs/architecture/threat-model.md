# Threat model

This page captures the security posture of the server **as it is today** — what we trust, what we don't, and where the sharp edges are. It covers both open issues it is filed under ([#43](https://github.com/jeanibarz/knowledge-base-mcp-server/issues/43) and [#44](https://github.com/jeanibarz/knowledge-base-mcp-server/issues/44)) and a small number of additional concerns that arose while documenting them.

The server is designed to run as a **local tool**: one user, one machine, one trusted terminal. It has no authentication layer because MCP stdio transport inherits the launching user's permissions (`src/KnowledgeBaseServer.ts:126-127`). The threat model below assumes that baseline.

## Trust boundaries at a glance

| Boundary                                | Risk shape                           | Who must be trusted                                          |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `$FAISS_INDEX_PATH`                     | Arbitrary code execution             | Everyone with write access to this directory.                |
| `$KNOWLEDGE_BASES_ROOT_DIR`             | Prompt-injection of downstream agent | Everyone who can author files here.                          |
| Embedding-provider network path         | Data confidentiality                 | The configured provider + the transport network.             |
| Process-to-process concurrency          | Index corruption                     | The operator (to run only one process per index).            |

Sections below go one level deeper on each.

## 1. `$FAISS_INDEX_PATH` is a code-execution boundary (#43)

`FaissStore.load()` deserializes the docstore that lives alongside `faiss.index`. The deserialization path inside `@langchain/community` uses `pickleparser@0.2.1` (`package.json:27`) to stay wire-compatible with Python LangChain. **Loading an attacker-controlled docstore is arbitrary-code-execution-shaped** on the platforms where pickle-style streams deserialize to native objects.

**RFC 013 multi-model layout** (0.3.0+): the trust boundary now extends to every `${FAISS_INDEX_PATH}/models/<model_id>/` subdirectory. Each model has its own `faiss.index/` + `model_name.txt`, and the same code-execution risk applies to each model's docstore independently. `${FAISS_INDEX_PATH}/active.txt` is also operator-trusted state — tampering with it can redirect agent retrievals to a wrong model (the slug regex hard-fails on malformed content, so the failure mode is "exit 2" rather than "silent vector-space mismatch", but the file should still be treated as security-sensitive).

**Requirement.** Every file inside `$FAISS_INDEX_PATH` (including every `models/<id>/` subtree and `active.txt`) must have been written by this server running against this user's configured embedding model. Specifically:

- Do **not** restore `$FAISS_INDEX_PATH` (or any `models/<id>/`) from an untrusted backup, container image, or package.
- Do **not** mount `$FAISS_INDEX_PATH` on a shared filesystem with write access for untrusted peers.
- Do **not** point `$FAISS_INDEX_PATH` at a directory another tool writes to.
- **Do** treat deletion as safe: `kb models remove <id>` (or `rm -rf ${FAISS_INDEX_PATH}/models/<id>/`) forces a rebuild on the next `kb models add`. The in-memory FaissStore in a running MCP server keeps working until process exit — verified empirically (RFC 013 §10 E6), `faiss-node` reads the index into memory at `.load()` time and does not mmap.

The surface is permanent until upstream swaps the docstore format away from pickle. ADR [`0001-faiss-over-qdrant.md`](./adr/0001-faiss-over-qdrant.md) explains why we stay with FAISS despite this cost; a future RFC may migrate the docstore to a JSON-only format.

## 2. `$KNOWLEDGE_BASES_ROOT_DIR` is a content / prompt-injection boundary

Content under `$KNOWLEDGE_BASES_ROOT_DIR` is read (`src/FaissIndexManager.ts:253-274`), chunked (`:261-267`), embedded, and returned **verbatim** to the MCP client inside the `retrieve_knowledge` response (`src/KnowledgeBaseServer.ts:92-107`). This is not a local code-execution risk — it's a prompt-injection risk **for whatever LLM the MCP client hands the response to**.

**Requirement.** The user owns every markdown file in this tree. If a file is scraped from the web or synced from a shared doc platform, it is effectively attacker-controlled from the downstream agent's perspective. Treat it like untrusted input to a downstream LLM, not like untrusted input to this process.

The server itself does no sanitization, no quoting, no prompt-injection detection. That is by design — RFC 006 layers filtering on top.

## 3. Embedding-provider keys

Three env vars are read at construction time (`src/FaissIndexManager.ts:98-121`, `src/config.ts:37-41`):

| Variable                  | Provider    | Leak surface                                           |
| ------------------------- | ----------- | ------------------------------------------------------ |
| `HUGGINGFACE_API_KEY`     | HuggingFace | Logged as *presence* metadata at `src/FaissIndexManager.ts:109-121`; never logged as payload. |
| `OPENAI_API_KEY`          | OpenAI      | Same — read at `src/FaissIndexManager.ts:98-107`, not persisted. |
| `OLLAMA_BASE_URL`         | Ollama      | URL only, no secret. Logged at startup.               |

**Requirement.** Keys are held in `process.env` for the life of the process and **never** written to disk (not to `model_name.txt`, not to sidecars, not to the log file unless the user set `LOG_FILE` AND also logged the environment themselves — the server doesn't). Rotating a key requires a process restart; there's no live-reload.

Query text and knowledge-base chunks leave the machine over TLS to the configured provider. The provider sees everything the server sees. Choose Ollama (local) if that matters.

## 4. Concurrency — single MCP per `$FAISS_INDEX_PATH`, per-model write locks (#44)

**Single-MCP-instance enforcement** (RFC 012 M1 — landed in 0.2.0). `acquireInstanceAdvisory` at `src/instance-lock.ts` writes a PID file at `${FAISS_INDEX_PATH}/.kb-mcp.pid` atomically (`O_CREAT | O_EXCL`, mode `0o600`) on `KnowledgeBaseServer.run()`. Two concurrent MCP servers against the same `$FAISS_INDEX_PATH` are refused — the second exits with `InstanceAlreadyRunningError`. Stale PID files (recorded PID is dead) are silently overwritten.

**Per-model write coordination** (RFC 013 M0 + M1+M2 — landed in 0.2.2 + 0.3.0). Short-lived `proper-lockfile` write locks at `${FAISS_INDEX_PATH}/models/<id>/.kb-write.lock`. Acquired around each `updateIndex` call (MCP `handleRetrieveKnowledge`, `ReindexTriggerWatcher`, `kb search --refresh`, `kb models add`); released immediately after. **Per-model granularity** means a long-running `kb models add B` (multi-minute embedding pass) does NOT block `kb search` against model A. Default `kb search` (read-only) does not acquire any lock.

**Migration coordination** (RFC 013 §4.8). `FaissIndexManager.bootstrapLayout` runs the 0.2.x→0.3.0 migration at most once per Node process (module-level Promise cache). Cross-process: piggybacks on the instance advisory if held, else acquires a short-lived `${FAISS_INDEX_PATH}/.kb-migration.lock` for CLI invocations to coordinate with peers.

**Current requirement.** Still **one MCP server** per `$FAISS_INDEX_PATH`. Multiple `kb` CLI invocations against the same path are safe — they coordinate via the per-model write lock. Users deploying under systemd / pm2 / Kubernetes still need to keep MCP-server replicas at 1 per `FAISS_INDEX_PATH` or give each replica its own.

**Known limitation.** `FaissStore.save()` from `@langchain/community` is non-atomic (`mkdir -p + Promise.all([index.write, writeFile(docstore.json)])`, no rename). A read concurrent with a save can see partial `docstore.json`; the CLI's `loadWithJsonRetry` handles this with a 100 ms retry. Documented in RFC 012 §7 N4. Per-model isolation in 0.3.0 narrows the blast radius (only that one model's reads can race).

## 5. Path-traversal (forward-looking)

Today neither exposed tool takes a filesystem path as input — `list_knowledge_bases` reads `KNOWLEDGE_BASES_ROOT_DIR` directly (`src/KnowledgeBaseServer.ts:52-72`), and `retrieve_knowledge` takes a `query` string, an optional `knowledge_base_name`, and an optional numeric `threshold` (`src/KnowledgeBaseServer.ts:43-47`). The `knowledge_base_name` is joined to `KNOWLEDGE_BASES_ROOT_DIR` at `src/FaissIndexManager.ts:222` with no `..` check — but a traversal value that tries to escape the root would just point at a directory that `getFilesRecursively` would walk harmlessly. There is no code path today that writes based on a client-supplied name.

RFC 010's proposed ingest / resources tools **will** take user-supplied paths. When that lands, the path resolution must canonicalize the value and reject components that escape `$KNOWLEDGE_BASES_ROOT_DIR`. Flagged here so it doesn't ship without guard rails.

## 6. Log file (`LOG_FILE`)

Setting `LOG_FILE` (`src/logger.ts:18-49`) mirrors stderr to disk. The server writes JSON-RPC error metadata, file paths scanned during indexing, and permission-denied stack traces — but **not** the embedding-provider payload or the query text. If `LOG_LEVEL=debug` (`src/logger.ts:14`), it additionally logs file paths that changed. None of this is secret by itself; treat the file as a normal operational log.

## Out of scope

- Denial-of-service by a malicious KB file large enough to OOM the embedding provider. Possible, but unlisted — the mitigation is operational (file-size cap in the source tree).
- Supply-chain attacks on the dependency graph. The repo does not currently pin peer deps or vendor; audit via `npm audit` is the user's responsibility.
- Remote MCP transport. Not implemented — RFC 008 covers it. The threat model will gain an auth section when that lands.
