# Knowledge Base MCP Server

[![Tests](https://github.com/jeanibarz/knowledge-base-mcp-server/actions/workflows/test.yml/badge.svg)](https://github.com/jeanibarz/knowledge-base-mcp-server/actions/workflows/test.yml)
[![License](https://img.shields.io/github/license/jeanibarz/knowledge-base-mcp-server)](./UNLICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](./package.json)

This MCP server provides tools for listing and retrieving content from different knowledge bases.

### Demo

Live demo recording coming soon ([tracking #40](https://github.com/jeanibarz/knowledge-base-mcp-server/issues/40)).

[![smithery badge](https://smithery.ai/badge/@jeanibarz/knowledge-base-mcp-server)](https://smithery.ai/server/@jeanibarz/knowledge-base-mcp-server)

<a href="https://glama.ai/mcp/servers/n0p6v0o0a4">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/n0p6v0o0a4/badge" alt="Knowledge Base Server MCP server" />
</a>

## Setup Instructions

These instructions assume you have Node.js (version 20 or higher) and npm installed on your system.

### Install (one command)

```bash
npx -y @jeanibarz/knowledge-base-mcp-server@latest
```

`npx` fetches the package from npm and launches the stdio server. Point your MCP client at `npx -y @jeanibarz/knowledge-base-mcp-server@latest` and configure the environment variables documented below. See [docs/clients.md](docs/clients.md) for copy-pasteable snippets (Claude Desktop, Codex CLI, Cursor, Continue, Cline).

> **Pin `@latest`, not the unversioned spec.** `npx -y @jeanibarz/knowledge-base-mcp-server` (no version) caches the resolved version in `~/.npm/_npx/` indefinitely — subsequent client launches reuse that cached version even after a new release ships. The `@latest` form hashes to a different cache key and re-resolves on every launch, so new fixes arrive on the next client restart instead of requiring a manual `~/.npm/_npx/` clear. See RFC 012 §2.4.

### Install (CLI alongside the MCP server, RFC 012)

For an interactive shell or AI-agent shell-tool flow, install globally and use the `kb` bin directly. The OS resolves the binary on every invocation, so `npm i -g …@latest` is picked up without restarting any AI client that has the MCP server loaded:

```bash
npm install -g @jeanibarz/knowledge-base-mcp-server@latest
kb list                       # list available knowledge bases
kb search "your query"        # read-only search; cheap, fast (~0.6 s)
kb search "query" --refresh   # also re-scan KB files (write path)
kb --help
```

The `kb` bin shares the same env vars as the MCP server (`KNOWLEDGE_BASES_ROOT_DIR`, `FAISS_INDEX_PATH`, `EMBEDDING_PROVIDER`, `OLLAMA_*`, `OPENAI_*`, `HUGGINGFACE_*`). `kb search` defaults to read-only — it loads the existing FAISS index but does not re-scan KB files. Pass `--refresh` to re-index. Output includes a freshness footer indicating whether the index is up-to-date relative to KB file mtimes.

The MCP server (`knowledge-base-mcp-server` bin) is unchanged and still works with all the configurations in [docs/clients.md](docs/clients.md). The CLI is additive.

### Comparing embedding models (RFC 013)

Once on 0.3.0, you can keep multiple embedding models side-by-side and query each by id. Useful for retrieval-quality A/B without losing the previous model:

```bash
# List registered models. The * marks the active one.
kb models list

# Add a second model — embeds your KB once under the new model.
# For paid providers, prints an estimated cost and prompts before any HTTP traffic.
kb models add ollama nomic-embed-text          # local, free
kb models add openai text-embedding-3-small    # paid; estimate first
kb models add huggingface BAAI/bge-small-en-v1.5

# Query a specific model without changing the default.
kb search "your query" --model=openai__text-embedding-3-small

# Side-by-side comparison: unified rank/score table over both models' top-k.
kb compare "your query" ollama__nomic-embed-text-latest openai__text-embedding-3-small

# Switch the default model.
kb models set-active openai__text-embedding-3-small

# Remove a model (refuses to remove the active one).
kb models remove huggingface__BAAI-bge-small-en-v1.5
```

`<model_id>` is `<provider>__<filesystem-safe-slug>`, derived deterministically from `(provider, model_name)` as typed (e.g. `OLLAMA_MODEL=nomic-embed-text:latest` → `ollama__nomic-embed-text-latest`). On-disk layout: each model lives at `${FAISS_INDEX_PATH}/models/<id>/`. The active model is recorded in `${FAISS_INDEX_PATH}/active.txt` and overridable per-process via `KB_ACTIVE_MODEL`. See [`docs/rfcs/013-multimodel-support.md`](docs/rfcs/013-multimodel-support.md) for the full design.

**Migration from 0.2.x → 0.3.0** is automatic on first server (or `kb`) start: the existing single-model index is moved into `${FAISS_INDEX_PATH}/models/<derived_id>/` and `active.txt` is written. Atomic, ~12 ms measured. **Before upgrading**, fully exit any AI client (Claude Code, Cursor, Continue, Cline) that has the MCP server loaded — the migration acquires the single-instance PID advisory before any rename, so it cannot run while a 0.2.x MCP child is still using the directory. See [CHANGELOG](CHANGELOG.md) for rollback recipes.

**MCP surface** — `retrieve_knowledge` gains an optional `model_name` argument; a new `list_models` tool returns the registered models. Tools that don't pass `model_name` keep working unchanged (wire format is byte-equal to 0.2.x).

### Install via Smithery

To install Knowledge Base Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@jeanibarz/knowledge-base-mcp-server):

```bash
npx -y @smithery/cli install @jeanibarz/knowledge-base-mcp-server --client claude
```

### Install from source

Use this path if you want to develop against the repo or pin an unreleased commit.

**Prerequisites**

*   [Node.js](https://nodejs.org/) (version 20 or higher)
*   [npm](https://www.npmjs.com/) (Node Package Manager)

1.  **Clone the repository:**

    ```bash
    git clone <repository_url>
    cd knowledge-base-mcp-server
    ```

2.  **Install dependencies:**

    ```bash
    npm install
    ```

3.  **Configure environment variables:**

    This server supports three embedding providers: **Ollama** (recommended for reliability), **OpenAI** and **HuggingFace** (fallback option).

    ### Option 1: Ollama Configuration (Recommended)
    
    *   Set `EMBEDDING_PROVIDER=ollama` to use local Ollama embeddings
    *   Install [Ollama](https://ollama.ai/) and pull an embedding model: `ollama pull dengcao/Qwen3-Embedding-0.6B:Q8_0`
    *   Configure the following environment variables:
        ```bash
        EMBEDDING_PROVIDER=ollama
        OLLAMA_BASE_URL=http://localhost:11434  # Default Ollama URL
        OLLAMA_MODEL=dengcao/Qwen3-Embedding-0.6B:Q8_0          # Default embedding model
        KNOWLEDGE_BASES_ROOT_DIR=$HOME/knowledge_bases
        ```

    ### Option 2: OpenAI Configuration

    *   Set `EMBEDDING_PROVIDER=openai` to use OpenAI API for embeddings
    *   Configure the following environment variables:
        ```bash
        EMBEDDING_PROVIDER=openai
        OPENAI_API_KEY=your_api_key_here
        OPENAI_MODEL_NAME=text-embedding-3-small
        KNOWLEDGE_BASES_ROOT_DIR=$HOME/knowledge_bases
        ```
    *   As of this release, the OpenAI default is `text-embedding-3-small` (up from `text-embedding-ada-002`). Both produce 1536-dim vectors, but the model name change will trigger a one-time FAISS index rebuild on the next query. Override with `OPENAI_MODEL_NAME=...` if you prefer the old default. See the [CHANGELOG](./CHANGELOG.md) for details.

    ### Option 3: HuggingFace Configuration (Fallback)
    
    *   Set `EMBEDDING_PROVIDER=huggingface` or leave unset (default)
    *   Obtain a free API key from [HuggingFace](https://huggingface.co/)
    *   Configure the following environment variables:
        ```bash
        EMBEDDING_PROVIDER=huggingface          # Optional, this is the default
        HUGGINGFACE_API_KEY=your_api_key_here
        HUGGINGFACE_MODEL_NAME=BAAI/bge-small-en-v1.5
        HUGGINGFACE_PROVIDER=hf-inference       # Optional, router provider for serverless inference
        KNOWLEDGE_BASES_ROOT_DIR=$HOME/knowledge_bases
        ```
    *   As of this release, the HuggingFace default is `BAAI/bge-small-en-v1.5` (up from `sentence-transformers/all-MiniLM-L6-v2`). Both produce 384-dim vectors, but the model name change will trigger a one-time FAISS index rebuild on the next query. Override with `HUGGINGFACE_MODEL_NAME=...` if you prefer the old default. See the [CHANGELOG](./CHANGELOG.md) for details.
    *   HuggingFace retired the legacy `api-inference.huggingface.co/models/...`
        endpoint in 2025. Feature-extraction calls are now routed through the
        Inference Providers router at
        `https://router.huggingface.co/hf-inference/models/<model>/pipeline/feature-extraction`
        by default. Set `HUGGINGFACE_PROVIDER` to choose a different supported
        Inference Provider such as `together`, `replicate`, `fireworks-ai`,
        `sambanova`, `nebius`, or `novita`. The existing
        `HUGGINGFACE_API_KEY` value can be either a Hugging Face token or a
        compatible provider key, depending on how the request is authenticated
        upstream. To target a self-hosted or dedicated Inference Endpoint, set
        `HUGGINGFACE_ENDPOINT_URL` to the full POST URL; explicit endpoint URLs
        bypass router provider selection.

    ### Additional Configuration
    
    *   The server supports the `FAISS_INDEX_PATH` environment variable to specify the path to the FAISS index. If not set, it will default to `$HOME/knowledge_bases/.faiss`.
    *   Logging can be routed to a file by setting `LOG_FILE=/path/to/logs/knowledge-base.log`. Log verbosity defaults to `info` and can be adjusted with `LOG_LEVEL=debug|info|warn|error`.
    *   **Tailor tool descriptions per deployment.** The `retrieve_knowledge` and `list_knowledge_bases` descriptions the agent reads when picking tools can be overridden via `RETRIEVE_KNOWLEDGE_DESCRIPTION` and `LIST_KNOWLEDGE_BASES_DESCRIPTION`. Unset or empty falls back to the built-in defaults. Example:
        ```bash
        RETRIEVE_KNOWLEDGE_DESCRIPTION="Search engineering runbooks, RFCs, and postmortems."
        LIST_KNOWLEDGE_BASES_DESCRIPTION="List available engineering knowledge bases."
        ```
    *   **Ingest filter overrides (RFC 011 M1).** The server embeds only files whose extension is in `{.md, .markdown, .txt, .rst}` and excludes workflow sidecars (`_seen.jsonl`, `_index.jsonl`), log / staging subtrees (`logs/`, `tmp/`, `_tmp/`), and OS turds (`.DS_Store`, `Thumbs.db`, `desktop.ini`). To extend the allowlist or add more exclusions:
        ```bash
        # Comma-separated extensions (case-insensitive; leading dot optional).
        INGEST_EXTRA_EXTENSIONS=".json,.yaml"
        # Comma-separated minimatch globs relative to the KB root.
        INGEST_EXCLUDE_PATHS="drafts/**,scratch.md"
        ```
        Extensionless files (e.g. `README`, `LICENSE`, `Makefile`) are **not** embedded by the default allowlist; rename them with a `.md` or `.txt` suffix if you want them indexed. The base exclusions are authoritative: operators can add more but cannot remove the built-ins.
    *   You can set these environment variables in your `.bashrc` or `.zshrc` file, or directly in the MCP settings.

4.  **Build the server:**

    ```bash
    npm run build
    ```

5.  **Add the server to your MCP client:**

    See [docs/clients.md](docs/clients.md) for copy-pasteable configuration snippets for Claude Desktop, Codex CLI, Cursor, Continue, and Cline.

6.  **Create knowledge base directories:**

    *   Create subdirectories within the `KNOWLEDGE_BASES_ROOT_DIR` for each knowledge base (e.g., `company`, `it_support`, `onboarding`).
    *   Place text files (e.g., `.txt`, `.md`) containing the knowledge base content within these subdirectories.

*   The server recursively reads all text files (e.g., `.txt`, `.md`) within the specified knowledge base subdirectories.
*   The server skips hidden files and directories (those starting with a `.`).
*   For each file, the server calculates the SHA256 hash and stores it in a file with the same name in a hidden `.index` subdirectory. This hash is used to determine if the file has been modified since the last indexing.
*   File content is split into chunks before indexing: `.md` files use `MarkdownTextSplitter` (heading-aware), and every other text file uses `RecursiveCharacterTextSplitter`. Both splitters share the same `chunkSize: 1000, chunkOverlap: 200` defaults, so a large `.txt`, `.rst`, or source file produces many chunks rather than a single embedding.
*   The content of each chunk is then added to a FAISS index, which is used for similarity search.
*   The FAISS index is automatically initialized when the server starts. It checks for changes in the knowledge base files and updates the index accordingly.

## Usage

The server exposes two tools:

*   `list_knowledge_bases`: Lists the available knowledge bases.
*   `retrieve_knowledge`: Retrieves similar chunks from the knowledge base based on a query. Optionally, if a knowledge base is specified, only that one is searched; otherwise, all available knowledge bases are considered. By default, at most 10 document chunks are returned with a score below a threshold of 2. A different threshold can optionally be provided using the `threshold` parameter.

You can use these tools through the MCP interface.

The `retrieve_knowledge` tool performs a semantic search using a FAISS index. The index is automatically updated when the server starts or when a file in a knowledge base is modified.

The output of the `retrieve_knowledge` tool is a markdown formatted string with the following structure:

````markdown
## Semantic Search Results

**Result 1:**

[Content of the most similar chunk]

**Source:**
```json
{
  "source": "[Path to the file containing the chunk]"
}
```

---

**Result 2:**

[Content of the second most similar chunk]

**Source:**
```json
{
  "source": "[Path to the file containing the chunk]"
}
```

> **Disclaimer:** The provided results might not all be relevant. Please cross-check the relevance of the information.
````

Each result includes the content of the most similar chunk, the source file, and a similarity score.

## Remote transport (optional)

By default the server speaks MCP over stdio — every supported client (Claude Desktop, Codex, Cursor, Continue, Cline) launches it as a child process. Stage 1 of [RFC 008](./docs/rfcs/008-remote-transport.md) adds an opt-in **SSE** transport for browser-based clients, Smithery remote mode, and shared deployments. Stdio is unchanged unless you set `MCP_TRANSPORT`.

```bash
export MCP_TRANSPORT=sse
export MCP_AUTH_TOKEN="$(openssl rand -base64 32)"   # must be ≥32 characters; shorter tokens abort startup
export MCP_ALLOWED_ORIGINS="http://localhost:5173"   # comma-separated; leave unset to deny all browser origins
export MCP_PORT=8765                                  # default
export MCP_BIND_ADDR=127.0.0.1                        # default — loopback only
node build/index.js
```

Endpoints exposed in this mode:

- `GET /health` — unauthenticated liveness probe; returns `200 {"status":"ok"}` only. Per RFC 008 §6.8 it intentionally exposes no version, uptime, or filesystem fingerprint to anonymous callers.
- `GET /sse` — long-lived SSE stream. Requires `Authorization: Bearer <MCP_AUTH_TOKEN>`.
- `POST /messages?sessionId=<uuid>` — JSON-RPC POST per session. Same bearer requirement.

Streamable-HTTP is **not** wired up in stage 1 — `MCP_TRANSPORT=http` is rejected at startup. See RFC 008 §9 for the full rollout plan.

**Security defaults:** the server refuses to start in SSE mode without `MCP_AUTH_TOKEN`, binds only to loopback, and uses a constant-time bearer comparison. Operators exposing the endpoint off-host should set `MCP_BIND_ADDR=0.0.0.0` *and* terminate TLS in a reverse proxy — TLS is out of scope for this server. Only one process per `FAISS_INDEX_PATH` is supported (see [`docs/architecture/threat-model.md`](./docs/architecture/threat-model.md)).

## Troubleshooting & Logging

- Set `LOG_FILE` to capture structured logs (JSON-RPC traffic continues to use stdout). This is especially helpful when diagnosing MCP handshake errors because all diagnostic messages are written to stderr and the optional log file.
- Permission errors when creating or updating the FAISS index are surfaced with explicit messages in both the console and the log file. Verify that the process can write to `FAISS_INDEX_PATH` and the `.index` directories inside each knowledge base.
- Run `npm test` to execute the Jest suite (serialised with `--runInBand`) that covers logger fallback behaviour and FAISS permission handling.

## Security

The server is designed to run as a **local tool**: one user, one machine, one trusted terminal. Two trust boundaries matter in practice. The `$FAISS_INDEX_PATH` directory is a **code-execution boundary** — `FaissStore.load` deserialises the docstore via `pickleparser`, so the directory must only contain files written by this server (no untrusted backups, no shared-write mounts). The `$KNOWLEDGE_BASES_ROOT_DIR` tree is a **content boundary** — its contents are embedded and returned verbatim to the MCP client, so markdown from untrusted sources is a prompt-injection risk for downstream agents. Additionally, only **one server process per `FAISS_INDEX_PATH`** is supported today; running multiple processes against the same index will corrupt it. Full discussion, including provider-key handling and the planned concurrency lockfile, is in [`docs/architecture/threat-model.md`](./docs/architecture/threat-model.md).
