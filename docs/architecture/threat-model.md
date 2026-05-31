# Threat model

This page captures the security posture of the server **as it is today** — what we trust, what we don't, and where the sharp edges are. It covers both open issues it is filed under ([#43](https://github.com/jeanibarz/knowledge-base-mcp-server/issues/43) and [#44](https://github.com/jeanibarz/knowledge-base-mcp-server/issues/44)) and a small number of additional concerns that arose while documenting them.

The server is designed to run as a **local tool**: one user, one machine, one trusted terminal. The default MCP `stdio` transport has no authentication layer because it inherits the launching user's permissions. The opt-in `MCP_TRANSPORT=sse` and `MCP_TRANSPORT=http` modes are guarded by a bearer token, an origin allow-list, and a loopback bind by default — see §8 below. The threat model below assumes the local-tool baseline unless an item explicitly calls out remote transport.

## Trust boundaries at a glance

| Boundary                                | Risk shape                           | Who must be trusted                                          |
| --------------------------------------- | ------------------------------------ | ------------------------------------------------------------ |
| `$FAISS_INDEX_PATH`                     | Arbitrary code execution             | Everyone with write access to this directory.                |
| `$KNOWLEDGE_BASES_ROOT_DIR`             | Prompt-injection of downstream agent | Everyone who can author files here.                          |
| KB-relative paths from MCP write tools / `kb://` resources | Path traversal out of `$KNOWLEDGE_BASES_ROOT_DIR` | The MCP client (paths are validated server-side, see §5). |
| Embedding-provider network path         | Data confidentiality                 | The configured provider + the transport network.             |
| Process-to-process concurrency          | Index corruption                     | The per-model write lock + atomic save (no operator action required, see §4). |
| `MCP_TRANSPORT=sse` / `=http` listener  | Remote callers reaching MCP tools    | Whoever holds `MCP_AUTH_TOKEN` + matches `MCP_ALLOWED_ORIGINS` (see §8). |

Sections below go one level deeper on each.

## 1. `$FAISS_INDEX_PATH` is a code-execution boundary (#43)

`FaissStore.load()` deserializes the docstore that lives alongside `faiss.index`. The deserialization path inside `@langchain/community` uses `pickleparser@0.2.1` (`package.json:27`) to stay wire-compatible with Python LangChain. **Loading an attacker-controlled docstore is arbitrary-code-execution-shaped** on the platforms where pickle-style streams deserialize to native objects.

**RFC 013 multi-model layout** (0.3.0+): the trust boundary now extends to every `${FAISS_INDEX_PATH}/models/<model_id>/` subdirectory. Each model has its own `faiss.index/` + `model_name.txt`, and the same code-execution risk applies to each model's docstore independently. `${FAISS_INDEX_PATH}/active.txt` is also operator-trusted state — tampering with it can redirect agent retrievals to a wrong model (the slug regex hard-fails on malformed content, so the failure mode is "exit 2" rather than "silent vector-space mismatch", but the file should still be treated as security-sensitive).

**Requirement.** Every file inside `$FAISS_INDEX_PATH` (including every `models/<id>/` subtree and `active.txt`) must have been written by this server running against this user's configured embedding model. Specifically:

- Do **not** restore `$FAISS_INDEX_PATH` (or any `models/<id>/`) from an untrusted backup, container image, or package.
- Do **not** mount `$FAISS_INDEX_PATH` on a shared filesystem with write access for untrusted peers.
- Do **not** point `$FAISS_INDEX_PATH` at a directory another tool writes to.
- Do run `kb doctor` after changing storage locations or restoring index files; it warns when the FAISS root, `active.txt`, the active model directory, or the active index version directory are group/world writable or owned by a different local user. These checks are best-effort and ownership is skipped on platforms that do not expose POSIX user IDs.
- **Do** treat deletion as safe: `kb models remove <id>` (or `rm -rf ${FAISS_INDEX_PATH}/models/<id>/`) forces a rebuild on the next `kb models add`. The in-memory FaissStore in a running MCP server keeps working until process exit — verified empirically (RFC 013 §10 E6), `faiss-node` reads the index into memory at `.load()` time and does not mmap.

The surface is permanent until upstream swaps the docstore format away from pickle. ADR [`0001-faiss-over-qdrant.md`](./adr/0001-faiss-over-qdrant.md) explains why we stay with FAISS despite this cost; a future RFC may migrate the docstore to a JSON-only format.

## 2. `$KNOWLEDGE_BASES_ROOT_DIR` is a content / prompt-injection boundary

Content under `$KNOWLEDGE_BASES_ROOT_DIR` is read (`src/FaissIndexManager.ts`), chunked, embedded, and returned to the MCP client inside the `retrieve_knowledge` response after retrieval-time formatting (`src/formatter.ts`). This is not a local code-execution risk — it's a prompt-injection risk **for whatever LLM the MCP client hands the response to**.

**Requirement.** The user owns every markdown file in this tree. If a file is scraped from the web or synced from a shared doc platform, it is effectively attacker-controlled from the downstream agent's perspective. Treat it like untrusted input to a downstream LLM, not like untrusted input to this process.

The ingest quarantine manifest at `<kb>/.index/quarantine.jsonl` is part of this
same content boundary. It records file paths, hashes, and error metadata for
operator repair; it is never loaded as executable index state and must not be
placed under `$FAISS_INDEX_PATH`.

The server applies retrieval-time content guards before chunks cross the formatter boundary. Issue [#217](https://github.com/jeanibarz/knowledge-base-mcp-server/issues/217) adds a strictly-additive, signal-only scanner (`src/kb-shield.ts`, wired through `src/formatter.ts`) that annotates each chunk with a top-level `injection_signals: Array<{rule, span_start, span_end}>` field when a versioned ruleset hits. The field is *evidence* — the chunk's `content` is not modified by the shield, and the markdown view surfaces an inline `> ⚠ injection-signal: <rule>` line so a human reviewer notices the same hit. Operators can disable the scanner with `KB_SHIELD=off` (the field is omitted entirely), and the ruleset is versioned via `KB_SHIELD_RULESET_VERSION` (currently `v1`) so additions are observable to downstream consumers.

Issue [#221](https://github.com/jeanibarz/knowledge-base-mcp-server/issues/221) adds a second guard contract for chunk metadata and opt-in delimiters. By default (`KB_INJECTION_GUARD` unset or `tag`), each chunk is scanned for common indirect-prompt-injection signals and the additive `metadata.injection_signals` array is emitted with the result. `KB_INJECTION_GUARD=wrap` wraps chunk content in an `<untrusted-doc>` envelope, and `KB_INJECTION_GUARD=both` combines wrapping with metadata signals. `KB_INJECTION_GUARD=off` disables only this metadata/wrap guard. `KB_INJECTION_GUARD_BYPASS_KBS` skips shield signals, metadata detection, and wrapping for explicitly named KBs that intentionally study injection content.

This guard is a boundary cue, not a guarantee. Pattern matching cannot eliminate prompt injection, and wrapped content still remains untrusted. Downstream agents must continue to treat retrieved text as data, not instructions. ADR [`0006-injection-guard-detect-tag-delimit.md`](./adr/0006-injection-guard-detect-tag-delimit.md) records the decision and constraints.

## 3. Embedding-provider keys

Provider env vars are resolved through the provider/config modules when a
manager initializes its embedding client:

| Variable                  | Provider    | Leak surface                                           |
| ------------------------- | ----------- | ------------------------------------------------------ |
| `HUGGINGFACE_API_KEY`     | HuggingFace | Logged as *presence* metadata at `src/FaissIndexManager.ts:109-121`; never logged as payload. |
| `OPENAI_API_KEY`          | OpenAI      | Same — read at `src/FaissIndexManager.ts:98-107`, not persisted. |
| `OLLAMA_BASE_URL`         | Ollama      | URL only, no secret. Logged at startup.               |

**Requirement.** Keys are held in `process.env` for the life of the process and **never** written to disk (not to `model_name.txt`, not to sidecars, not to the log file unless the user set `LOG_FILE` AND also logged the environment themselves — the server doesn't). Rotating a key requires a process restart; there's no live-reload.

Query text and knowledge-base chunks leave the machine over TLS to the configured provider. The provider sees everything the server sees. Choose Ollama (local) if that matters.

## 4. Concurrency — per-model write locks + atomic save (#44)

**Per-model write coordination** (RFC 013 M0 + M1+M2 — landed in 0.2.2 + 0.3.0). Short-lived `proper-lockfile` write locks at `${FAISS_INDEX_PATH}/models/<id>/.kb-write.lock`. Acquired around each `updateIndex` call (MCP `handleRetrieveKnowledge`, `ReindexTriggerWatcher`, `kb search --refresh`, `kb models add`); released immediately after. **Per-model granularity** means a long-running `kb models add B` (multi-minute embedding pass) does NOT block `kb search` against model A. Default `kb search` (read-only) does not acquire any lock.

**Atomic save** (RFC 014). Per-model layout `index → index.vN/` makes save+load directory-atomic via symlink-swap with reader-side pre-resolution. Torn reads are eliminated for the versioned layout. The legacy `faiss.index/` load path retains the prior hazard until and unless a write under v014 (`updateIndex`, `kb search --refresh`, or `kb models add`) creates the versioned layout for that model. `loadWithJsonRetry` (CLI) remains as a defensive belt for legacy-layout reads only; planned for removal once the legacy load path is dropped.

**Migration coordination** (RFC 013 §4.8). `FaissIndexManager.bootstrapLayout` runs the 0.2.x→0.3.0 migration at most once per Node process (module-level Promise cache). Cross-process: every caller acquires a short-lived `${FAISS_INDEX_PATH}/.kb-migration.lock` for the duration of `maybeMigrateLayout`. Pre-RFC-014 the MCP server piggybacked on the single-instance PID advisory it held for its lifetime; since the advisory was removed (atomic save + per-model write lock are sufficient for data integrity), MCP and CLI start paths use the same migration-lock primitive.

**Multiple MCP servers per `$FAISS_INDEX_PATH` are now supported.** The single-instance advisory at `src/instance-lock.ts` was removed. Two concurrent MCP servers serialize writes via the per-model lock, never produce torn reads thanks to atomic save, and have always coexisted safely at read time. Any leftover `${FAISS_INDEX_PATH}/.kb-mcp.pid` file from a prior install is now an orphan that the operator may delete (no code reads it).

## 5. Path-traversal (path-taking tools and `kb://` resources)

Exposed mutation/resource surfaces that accept client-supplied paths into
`$KNOWLEDGE_BASES_ROOT_DIR` route candidates through shared KB path helpers, so
the guard chain is implemented once:

1. **Lexical guards** — empty path, embedded null byte, and `..` traversal are rejected before any I/O.
2. **KB-name validation** — `knowledge_base_name` must match `isValidKbName`; the resolved KB directory must exist as a real directory under `KNOWLEDGE_BASES_ROOT_DIR`.
3. **Lexical inside-or-equal check** — the resolved candidate is required to live under the KB root before any `realpath` call.
4. **`realpath` check** — when the target or nearest existing ancestor resolves through symlinks, the realpath must still be inside the KB realpath. Symlink jailbreaks fail closed.

The current path-taking surfaces are:

| Surface | Where the path comes in | mustExist | Notes |
| --- | --- | --- | --- |
| `add_document` | `path` arg, joined with `knowledge_base_name` | `false` | Snapshots existing content first; index update failure rolls the file write back. |
| `delete_document` | `path` arg, joined with `knowledge_base_name` | `false` | Removes the source file and its hash sidecar; FAISS orphan vectors persist until a forced rebuild. |
| `reindex_knowledge_base` | optional `knowledge_base_name` only — no per-file path | n/a | Resolves the KB directory to validate the name; the rebuild is global (no per-vector deletion in this server). |
| `resources/read` for `kb://<kb>/<rel-path>` | URI authority + path | `true` | URI parser additionally rejects encoded slash/backslash and `..` segments before per-segment decoding. PDFs are returned as base64 blobs; everything else as UTF-8 text. |

`list_knowledge_bases` continues to read `KNOWLEDGE_BASES_ROOT_DIR` directly without taking any client path. `retrieve_knowledge` takes only `query`, optional `knowledge_base_name`, optional numeric filters, and never writes based on the name.

**Requirement.** The KB root and every per-KB directory must not contain symlinks pointing outside `KNOWLEDGE_BASES_ROOT_DIR`. The realpath check would catch a jailbreak attempt at request time, but symlinks-out-of-root represent operator-side trust intent. Treat the KB root the way you'd treat a static-content directory served to anonymous callers — own every entry, even the symlink targets.

## 6. Log file (`LOG_FILE`)

Setting `LOG_FILE` (`src/logger.ts:18-49`) mirrors stderr to disk. The server writes JSON-RPC error metadata, file paths scanned during indexing, and permission-denied stack traces — but **not** the embedding-provider payload or the query text. If `LOG_LEVEL=debug` (`src/logger.ts:14`), it additionally logs file paths that changed. None of this is secret by itself; treat the file as a normal operational log.

## 7. Mutation audit log (`KB_MUTATION_AUDIT_LOG`)

Setting `KB_MUTATION_AUDIT_LOG` (`src/audit-log.ts`) opts into an append-only JSONL ledger of content mutations performed by `kb remember`, `kb capture`, `kb ask --save-transcript`, MCP `add_document`, and MCP `delete_document`. Each record carries `surface`, `operation`, `kb`, `relative_path`, before/after `sha256` hashes, `write_performed`, refresh status, and `decision_flags`. Note bodies are **not** written; the hashes are the only content-derived field. KB names and relative paths reveal the same surface area as the underlying KB directory listing, so secure the ledger with the same permissions you grant `$KNOWLEDGE_BASES_ROOT_DIR`. Audit writes are best-effort: a failed append degrades to a `warn` line on stderr and never blocks the primary mutation.

## 8. Remote MCP transport (`MCP_TRANSPORT=sse` / `=http`)

`MCP_TRANSPORT` defaults to `stdio` and the rest of this document assumes that baseline. When the operator opts into `sse` or `http`, the server stands up a `node:http` listener (`src/transport/sse.ts:1-22`, `src/transport/http.ts:1-38`) sharing the dispatch gates defined in `src/transport/base-http-host.ts`. The exposed surface is `GET /health` (unauthenticated, returns only `{"status":"ok"}`), plus `GET /sse` + `POST /messages` (SSE) or `POST|GET|DELETE /mcp` (streamable HTTP).

**Mandatory auth.** The server refuses to start in either remote mode without `MCP_AUTH_TOKEN`, and rejects tokens shorter than 32 characters (`src/transport-config.ts:166-179`). The bearer comparison uses `timingSafeEqual` with a latin1-encoded token buffer so an attacker-controlled `Authorization` header can't be silently re-encoded into an equal-length payload (`src/transport/base-http-host.ts:95-107`, `:451-467`). Repeated bearer failures from the same `remoteAddress` enter a bounded in-memory backoff (`MCP_AUTH_BACKOFF_THRESHOLD`, `MCP_AUTH_BACKOFF_MS`, `MCP_AUTH_BACKOFF_MAX_ENTRIES`) and return `Retry-After`; a successful bearer token clears that address state (`src/transport/base-http-host.ts:350-370`, `:477-538`). Only `/health` is unauthenticated.

**Origin allow-list.** `MCP_ALLOWED_ORIGINS` is a comma-separated list of explicit origins; the wildcard `*` is rejected at config load (`src/transport-config.ts:124-137`). When set, browser-originated requests whose `Origin` header is not in the normalized list are denied before any handler runs. When unset, browser origins are denied; only same-process clients without an `Origin` header (and the operator's allow-listed entries) reach the auth gate.

**Default loopback bind.** `MCP_BIND_ADDR` defaults to `127.0.0.1` (`src/transport-config.ts:14-15`, `:140-145`). Operators who want off-host reach must set `MCP_BIND_ADDR=0.0.0.0` **and** terminate TLS in a reverse proxy: this server does not negotiate TLS, does not load certificates, and does not provide general request rate limiting beyond failed-auth backoff. Behind a reverse proxy the backoff key is the proxy socket address, not `X-Forwarded-For`, so internet-facing deployments still need proxy-side throttling. Without TLS, the bearer token travels in cleartext over the LAN.

**`/health` reveals no fingerprint.** Per RFC 008 §6.8 the body is `{"status":"ok"}` and nothing else — no version, uptime, build hash, or KB path is exposed to unauthenticated callers (`src/transport/base-http-host.ts` `/health` branch).

**Session isolation.** Each SSE or streamable-HTTP session gets its own `McpServer` (`src/KnowledgeBaseServer.ts:929-955`); tools cannot cross sessions. Long-lived `GET /sse` does not increment the drain counter so shutdown cannot stall on idle viewers (`src/transport/sse.ts:61-75`).

**Out of scope for the remote transport.** TLS termination, general request rate-limiting, audit logging beyond the per-request access line and failed-auth backoff warnings, and any kind of multi-tenant access control. The operator must layer those in front of the listener if remote exposure is intended for anyone other than the launching user.

## Out of scope

- Denial-of-service by a malicious KB file large enough to OOM the embedding provider. Possible, but unlisted — the mitigation is operational (file-size cap in the source tree).
- Supply-chain attacks on the dependency graph. The repo does not currently pin peer deps or vendor; audit via `npm audit` is the user's responsibility.
- TLS / certificate handling for `MCP_TRANSPORT=sse|http`. Terminate TLS in a reverse proxy if the listener is exposed off-host (see §8).

## Checked against

This page is verified against the following source files and README sections. If one of these moves or its cited lines drift, refresh this doc rather than letting the claim go stale.

- Path validation (write tools + resources): `src/kb-fs.ts`, `src/kb-paths.ts`, `src/mcp-resources.ts`.
- Write-tool surfaces: `src/KnowledgeBaseServer.ts`, `src/mcp-document-mutations.ts`.
- `resources/read` body: `src/mcp-resources.ts`.
- Per-model write lock + atomic save: `src/write-lock.ts`, `src/faiss-store-layout.ts:58-179`.
- Transport config + bearer / origin gates: `src/transport-config.ts:14-122`, `src/transport/base-http-host.ts`.
- Remote transport hosts: `src/transport/sse.ts:1-139`, `src/transport/http.ts:1-220`.
- Retrieval-time injection guard: `src/injection-guard.ts`, `src/formatter.ts`.
