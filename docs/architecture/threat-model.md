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

`FaissStore.load()` at `src/FaissIndexManager.ts:169` deserializes the docstore that lives alongside `faiss.index`. The deserialization path inside `@langchain/community` uses `pickleparser@0.2.1` (`package.json:27`) to stay wire-compatible with Python LangChain. **Loading an attacker-controlled docstore is arbitrary-code-execution-shaped** on the platforms where pickle-style streams deserialize to native objects.

**Requirement.** Every file inside `$FAISS_INDEX_PATH` must have been written by this server running against this user's configured embedding model. Specifically:

- Do **not** restore `$FAISS_INDEX_PATH` from an untrusted backup, container image, or package.
- Do **not** mount `$FAISS_INDEX_PATH` on a shared filesystem with write access for untrusted peers.
- Do **not** point `$FAISS_INDEX_PATH` at a directory another tool writes to.
- **Do** treat deletion as safe: removing `$FAISS_INDEX_PATH/faiss.index` forces a rebuild from source on the next `retrieve_knowledge` call (see [`sequence-reindex.md`](./sequence-reindex.md) and [`state-index.md`](./state-index.md)).

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

## 4. Concurrency — single process per `$FAISS_INDEX_PATH` (#44)

`FaissIndexManager.updateIndex` at `src/FaissIndexManager.ts:202-389` has **no file-level locking**. Two server processes pointing at the same `$FAISS_INDEX_PATH` will race on:

- `FaissStore.save` at `src/FaissIndexManager.ts:351` — there is no `.tmp` + rename for the index itself; a partial write from one process can be read by the other.
- Hash-sidecar tmp+rename at `src/FaissIndexManager.ts:362-377` — safe per-file, not safe across interleaved writers.
- The upcoming pending-manifest protocol (RFC 007 §6.2.1) — single-writer assumption is load-bearing there.

**Current requirement.** One server process per `$FAISS_INDEX_PATH`. Running two against the same path **will corrupt the index**.

This is a documented constraint, not an enforced one. Users deploying under systemd with `Restart=on-failure`, pm2, Kubernetes with `replicas > 1`, or containerized with a shared volume, need to configure their orchestrator to keep the process count at 1 (or give each replica its own `FAISS_INDEX_PATH`).

**Planned fix.** An `O_EXCL` lockfile at `$FAISS_INDEX_PATH/.lock` containing the PID, written in `initialize()` and removed in the SIGINT handler (`src/KnowledgeBaseServer.ts:27-30`). On startup, if `.lock` exists and its PID is alive, refuse to start with a clear error; if the PID is dead, warn and reclaim. Tracked in issue #44 for a follow-up RFC.

## 5. Path-traversal (forward-looking)

Today neither exposed tool takes a filesystem path as input — `list_knowledge_bases` reads `KNOWLEDGE_BASES_ROOT_DIR` directly (`src/KnowledgeBaseServer.ts:52-72`), and `retrieve_knowledge` takes a `query` string, an optional `knowledge_base_name`, and an optional numeric `threshold` (`src/KnowledgeBaseServer.ts:43-47`). The `knowledge_base_name` is joined to `KNOWLEDGE_BASES_ROOT_DIR` at `src/FaissIndexManager.ts:222` with no `..` check — but a traversal value that tries to escape the root would just point at a directory that `getFilesRecursively` would walk harmlessly. There is no code path today that writes based on a client-supplied name.

RFC 010's proposed ingest / resources tools **will** take user-supplied paths. When that lands, the path resolution must canonicalize the value and reject components that escape `$KNOWLEDGE_BASES_ROOT_DIR`. Flagged here so it doesn't ship without guard rails.

## 6. Log file (`LOG_FILE`)

Setting `LOG_FILE` (`src/logger.ts:18-49`) mirrors stderr to disk. The server writes JSON-RPC error metadata, file paths scanned during indexing, and permission-denied stack traces — but **not** the embedding-provider payload or the query text. If `LOG_LEVEL=debug` (`src/logger.ts:14`), it additionally logs file paths that changed. None of this is secret by itself; treat the file as a normal operational log.

## Out of scope

- Denial-of-service by a malicious KB file large enough to OOM the embedding provider. Possible, but unlisted — the mitigation is operational (file-size cap in the source tree).
- Supply-chain attacks on the dependency graph. The repo does not currently pin peer deps or vendor; audit via `npm audit` is the user's responsibility.
- Remote MCP transport. Not implemented — RFC 008 covers it. The threat model will gain an auth section when that lands.
